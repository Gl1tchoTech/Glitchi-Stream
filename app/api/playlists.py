import asyncio
import os
import re
import tempfile
import time
import uuid
import zipfile
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, HttpUrl

from app.api.download import _run_download_task
from app.config import settings
from app.models.requests import DownloadRequest
from app.services.download_task_manager import task_manager
from app.services.file_service import get_downloaded_files, get_file_path
from app.services.spotify_search_service import get_album_tracks
from app.utils.logger import logger
from app.utils.validators import is_spotify_url

router = APIRouter(prefix="/playlists", tags=["Playlists"])


class ZipRequest(BaseModel):
    filenames: List[str]


def _cleanup_temp(path: str):
    """Remove a temporary file."""
    try:
        if os.path.exists(path):
            os.unlink(path)
            logger.info(f"Cleaned up temp zip: {path}")
    except Exception as e:
        logger.error(f"Failed to clean up temp file {path}: {e}")


@router.post("/download-zip")
async def download_playlist_zip(req: ZipRequest, bg_tasks: BackgroundTasks):
    """Accept a list of filenames and return a zip file."""
    if not req.filenames:
        raise HTTPException(status_code=400, detail="No files specified")

    # Try to find files - skip missing ones instead of erroring
    paths = []
    missing = []
    for f in req.filenames:
        try:
            paths.append(get_file_path(f))
        except (ValueError, FileNotFoundError):
            missing.append(f)

    if not paths:
        raise HTTPException(status_code=404, detail=f"None of the requested files exist. Missing: {', '.join(missing[:5])}")

    # Also try to find files by partial name match in downloads dir
    if missing:
        all_files = get_downloaded_files()
        for fname in missing:
            for df in all_files:
                if fname in df.filename or df.filename in fname:
                    try:
                        paths.append(get_file_path(df.filename))
                        break
                    except (ValueError, FileNotFoundError):
                        pass

    # Create temp zip
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in paths:
                zf.write(path, arcname=os.path.basename(path))
    except Exception as e:
        os.unlink(tmp.name)
        raise HTTPException(status_code=500, detail=f"Zip creation failed: {e}")

    # Schedule cleanup after response
    bg_tasks.add_task(_cleanup_temp, tmp.name)

    return FileResponse(
        path=tmp.name,
        media_type="application/zip",
        filename="playlist.zip",
    )


@router.get("/album-tracks/{album_id}")
async def album_tracks(album_id: str):
    """Get tracks for an album by Spotify ID."""
    try:
        tracks = get_album_tracks(album_id)
        return {"tracks": tracks}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to get album tracks: {e}")


# ── Playlist / album jobs ────────────────────────────────────────────────
#
# A "job" is a server-side batch of download tasks. The browser only needs
# the job id: progress, per-track state and the finished ZIP all live on the
# server, so a phone can leave Safari, come back an hour later and still pick
# the ZIP up.

_MAX_JOB_TRACKS = 200
_JOB_TTL = 2 * 3600  # tasks are dropped after 2h, so jobs follow suit
_jobs: dict[str, dict] = {}


class JobTrack(BaseModel):
    url: HttpUrl
    artist: Optional[str] = ""
    title: Optional[str] = ""


class JobRequest(BaseModel):
    name: Optional[str] = "Playlist"
    playlist_id: Optional[str] = None  # Spotify id, used for the /p/<id> page
    tracks: List[JobTrack]
    quality: Optional[str] = "HIGH"
    downloader: Optional[str] = None


def _prune_jobs() -> None:
    now = time.time()
    for job_id in [k for k, v in _jobs.items() if now - v["created_at"] > _JOB_TTL]:
        _jobs.pop(job_id, None)


def _job_snapshot(job_id: str) -> Optional[dict]:
    job = _jobs.get(job_id)
    if not job:
        return None

    items = []
    completed = 0
    failed = 0
    filenames = []

    for meta in job["tracks"]:
        task = task_manager.get_task(meta["task_id"])
        if not task:
            continue
        status = task.status
        if status == "complete":
            completed += 1
            if task.filename:
                filenames.append(task.filename)
        elif status == "failed":
            failed += 1
        items.append(
            {
                "task_id": task.task_id,
                "url": meta["url"],
                "name": meta.get("name", ""),
                "artist": meta.get("artist", ""),
                "status": status,
                "stage": task.stage,
                "filename": task.filename,
                "error": task.error,
            }
        )

    total = len(job["tracks"])
    done = completed + failed
    return {
        "job_id": job_id,
        "playlist_id": job.get("playlist_id"),
        "name": job["name"],
        "total": total,
        "completed": completed,
        "failed": failed,
        "done": done,
        "status": "complete" if done >= total else "running",
        "filenames": filenames,
        "items": items,
    }


@router.post("/jobs")
async def create_job(req: JobRequest):
    """Start a batch download job and return its id."""
    if not req.tracks:
        raise HTTPException(status_code=400, detail="No tracks specified")
    if len(req.tracks) > _MAX_JOB_TRACKS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many tracks — the limit is {_MAX_JOB_TRACKS} per job",
        )

    _prune_jobs()

    playlist_id = re.sub(r"[^A-Za-z0-9]", "", req.playlist_id or "")[:64] or None
    job_id = uuid.uuid4().hex[:12]
    tracks = []
    for track in req.tracks:
        url = str(track.url)
        if not is_spotify_url(url):
            continue
        task = task_manager.create_task(url)
        track_req = DownloadRequest(
            url=url,
            quality=req.quality or "HIGH",
            downloader=req.downloader,
            artist=track.artist or "",
            title=track.title or "",
        )
        asyncio.create_task(_run_download_task(task.task_id, track_req))
        tracks.append(
            {
                "task_id": task.task_id,
                "url": url,
                "artist": track.artist or "",
                "name": track.title or "",
            }
        )

    if not tracks:
        raise HTTPException(status_code=400, detail="No valid Spotify track URLs in that job")

    _jobs[job_id] = {
        "job_id": job_id,
        "playlist_id": playlist_id,
        "name": (req.name or "Playlist")[:120],
        "tracks": tracks,
        "created_at": time.time(),
    }
    logger.info(f"Job {job_id} started with {len(tracks)} track(s)")
    return _job_snapshot(job_id)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Poll a job: progress, per-track state and the files that are ready."""
    snapshot = _job_snapshot(job_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Job not found")
    return snapshot


@router.get("/jobs/by-playlist/{playlist_id}")
async def get_job_by_playlist(playlist_id: str):
    """Return the newest job for a playlist id, so /p/<id> survives a refresh."""
    _prune_jobs()
    clean = re.sub(r"[^A-Za-z0-9]", "", playlist_id)
    matches = [job for job in _jobs.values() if clean and job.get("playlist_id") == clean]
    if not matches:
        raise HTTPException(status_code=404, detail="No download found for that playlist link")
    latest = max(matches, key=lambda job: job["created_at"])
    return _job_snapshot(latest["job_id"])


@router.get("/jobs/{job_id}/zip")
async def download_job_zip(job_id: str, bg_tasks: BackgroundTasks):
    """Zip whatever the job has finished so far and hand it to the browser."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    paths = []
    for meta in job["tracks"]:
        task = task_manager.get_task(meta["task_id"])
        if not task or task.status != "complete" or not task.filename:
            continue
        try:
            paths.append(get_file_path(task.filename))
        except (ValueError, FileNotFoundError):
            continue

    if not paths:
        raise HTTPException(status_code=404, detail="No finished tracks in this job yet")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in paths:
                zf.write(path, arcname=os.path.basename(path))
    except Exception as e:
        os.unlink(tmp.name)
        raise HTTPException(status_code=500, detail=f"Zip creation failed: {e}")

    bg_tasks.add_task(_cleanup_temp, tmp.name)

    safe_name = re.sub(r"[^A-Za-z0-9._ -]", "", job["name"]).strip() or "playlist"
    return FileResponse(
        path=tmp.name,
        media_type="application/zip",
        filename=f"{safe_name}.zip",
    )
