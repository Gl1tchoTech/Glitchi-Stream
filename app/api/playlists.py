import os
import zipfile
import tempfile
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List
from app.config import settings
from app.services.file_service import get_file_path, get_downloaded_files
from app.services.spotify_search_service import get_album_tracks
from app.utils.logger import logger

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
