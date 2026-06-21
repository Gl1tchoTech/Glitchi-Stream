import asyncio
import os

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse

from app.models.requests import DownloadRequest
from app.models.responses import BaseResponse
from app.services.spotiflac_service import (
    execute_download,
    execute_download_with_progress,
    find_spotiflac,
    log_downloaded_files,
)
from app.services.file_service import get_downloaded_files
from app.services.download_task_manager import task_manager
from app.utils.validators import is_spotify_url
from app.config import settings
from app.utils.logger import logger

router = APIRouter(prefix="/download", tags=["Download"])


@router.post("/", response_model=BaseResponse)
async def trigger_download(req: DownloadRequest, bg_tasks: BackgroundTasks):
    """Queue a download (fire and forget, no progress tracking)."""
    if not is_spotify_url(str(req.url)):
        raise HTTPException(status_code=400, detail="Not a valid Spotify URL")

    bg_tasks.add_task(execute_download, req)
    return BaseResponse(message="Download queued successfully")


# ── Task-based download with progress bar ──────────────────────────


async def _run_download_task(task_id: str, req: DownloadRequest) -> None:
    """Background coroutine that runs SpotiFLAC and updates task status."""
    semaphore = task_manager.get_semaphore()

    async with semaphore:
        async def on_progress(stage: str, detail: str) -> None:
            if stage == "complete":
                task_manager.update_task(
                    task_id,
                    status="complete",
                    stage="Ready!",
                    filename=detail,
                )
            elif stage == "failed":
                task_manager.update_task(
                    task_id,
                    status="failed",
                    stage="Failed",
                    error=detail,
                )
            else:
                task_manager.update_task(
                    task_id,
                    status=stage,
                    stage=detail,
                )

        filename = await execute_download_with_progress(req, on_progress=on_progress)

        # Safety net: catch cases where on_progress didn't fire (e.g. early exceptions)
        if task_manager.get_task(task_id):
            task = task_manager.get_task(task_id)
            if task and task.status not in ("complete", "failed"):
                if filename:
                    task_manager.update_task(
                        task_id,
                        status="complete",
                        stage="Ready!",
                        filename=filename,
                    )
                else:
                    task_manager.update_task(
                        task_id,
                        status="failed",
                        stage="Failed",
                        error="Unknown error during download",
                    )


@router.post("/task")
async def start_download_task(req: DownloadRequest):
    """
    Start a download task with progress tracking.
    Returns a task_id that can be used to poll for progress.
    """
    if not is_spotify_url(str(req.url)):
        raise HTTPException(status_code=400, detail="Not a valid Spotify URL")

    task = task_manager.create_task(str(req.url))

    # Fire and forget the download in the background
    asyncio.create_task(_run_download_task(task.task_id, req))

    return {
        "task_id": task.task_id,
        "message": "Download started",
    }


@router.get("/progress/{task_id}")
async def get_download_progress(task_id: str):
    """
    Poll for download task progress.
    Returns the current task state: status, stage, filename, error.
    """
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return {
        "task_id": task.task_id,
        "status": task.status,
        "stage": task.stage,
        "filename": task.filename,
        "error": task.error,
    }


@router.get("/result/{task_id}")
async def get_download_result(task_id: str):
    """
    Get the downloaded file for a completed task.
    Must be called after the task is in 'complete' status.
    """
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status == "failed":
        raise HTTPException(status_code=500, detail=task.error or "Download failed")

    if task.status != "complete":
        raise HTTPException(
            status_code=425,
            detail=f"Download not ready. Status: {task.status}",
        )

    if not task.filename:
        raise HTTPException(status_code=500, detail="No filename recorded for completed task")

    file_path = os.path.join(settings.DOWNLOAD_DIR, task.filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Downloaded file not found on disk")

    return FileResponse(
        path=file_path,
        media_type="application/octet-stream",
        filename=os.path.basename(task.filename),
    )


# ── Direct download (backward compat) ──────────────────────────────


@router.post("/now")
async def download_now(req: DownloadRequest):
    """
    Download a track immediately and return the file to the browser.
    Waits for SpotiFLAC to complete, then sends the file as a download.
    The file is also stored in ./downloads.
    """
    if not is_spotify_url(str(req.url)):
        raise HTTPException(status_code=400, detail="Not a valid Spotify URL")

    # Get list of files before download
    files_before = set()
    for f in get_downloaded_files():
        files_before.add(f.filename)

    # Run SpotiFLAC synchronously
    spotiflac_bin = find_spotiflac()
    if not spotiflac_bin:
        raise HTTPException(
            status_code=500,
            detail="SpotiFLAC binary not found. Install with: pip install spotiflac",
        )

    cmd_args = [spotiflac_bin, str(req.url), settings.DOWNLOAD_DIR]
    if req.services:
        cmd_args.extend(["--service", *req.services])
    if req.quality:
        cmd_args.extend(["--quality", req.quality])

    timeout = req.timeout_s if req.timeout_s and req.timeout_s >= 30 else 600

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=float(timeout)
        )

        if proc.returncode != 0:
            err_msg = stderr.decode().strip() or "Unknown error"
            raise HTTPException(
                status_code=500,
                detail=f"Download failed: {err_msg}",
            )
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await asyncio.wait_for(proc.wait(), timeout=10)
        except Exception:
            pass
        raise HTTPException(status_code=504, detail="Download timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Download error: {e}")

    # Find the newly downloaded file
    log_downloaded_files()

    # Poll for new files (up to 5 seconds)
    new_file = None
    for _ in range(10):
        await asyncio.sleep(0.5)
        for f in get_downloaded_files():
            if f.filename not in files_before and f.extension in (".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus"):
                new_file = f
                break
        if new_file:
            break

    if not new_file:
        # Fallback: check the downloads directory directly
        try:
            all_files = []
            for root, _, filenames in os.walk(settings.DOWNLOAD_DIR):
                for fn in filenames:
                    if fn == ".gitkeep":
                        continue
                    abs_path = os.path.join(root, fn)
                    rel = os.path.relpath(abs_path, settings.DOWNLOAD_DIR)
                    all_files.append((rel, os.path.getmtime(abs_path)))
            all_files.sort(key=lambda x: x[1], reverse=True)
            for rel_path, _ in all_files:
                if rel_path not in files_before:
                    new_file_path = os.path.join(settings.DOWNLOAD_DIR, rel_path)
                    if os.path.exists(new_file_path) and os.path.getsize(new_file_path) > 102400:
                        return FileResponse(
                            path=new_file_path,
                            media_type="application/octet-stream",
                            filename=os.path.basename(rel_path),
                        )
        except Exception:
            pass
        raise HTTPException(status_code=404, detail="Downloaded file not found")

    # Return the file
    new_file_path = os.path.join(settings.DOWNLOAD_DIR, new_file.filename)
    if not os.path.exists(new_file_path):
        raise HTTPException(status_code=404, detail="Downloaded file disappeared")

    return FileResponse(
        path=new_file_path,
        media_type="application/octet-stream",
        filename=os.path.basename(new_file.filename),
    )
