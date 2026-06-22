import asyncio
import os

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from app.models.requests import DownloadRequest
from app.models.responses import BaseResponse
from app.services.downloader_service import (
    run_download,
    log_downloaded_files,
    get_available_downloaders,
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

    bg_tasks.add_task(_fire_and_forget_download, req)
    return BaseResponse(message="Download queued successfully")


async def _fire_and_forget_download(req: DownloadRequest) -> None:
    """Background download task (no progress tracking)."""
    logger.info(f"Fire-and-forget download: {req.url}")
    filename = await run_download(req)
    if filename:
        log_downloaded_files()


# ── Task-based download with progress bar ──────────────────────────


async def _run_download_task(task_id: str, req: DownloadRequest) -> None:
    """Background coroutine that runs the selected downloader and updates task status."""
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

        filename = await run_download(req, on_progress=on_progress)

        # Safety net: catch cases where on_progress didn't fire
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
    Uses the configured downloader (SpotiFLAC / yt-dlp / SpotDL).
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
    """Poll for download task progress."""
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
    """Get the downloaded file for a completed task."""
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


# ── Downloader info ──────────────────────────────────────────────


@router.get("/available")
async def available_downloaders():
    """Return list of available downloaders and the currently selected one."""
    return {
        "available": get_available_downloaders(),
        "current": settings.DEFAULT_DOWNLOADER,
    }
