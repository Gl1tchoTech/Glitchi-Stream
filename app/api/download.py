import asyncio
import os

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from app.models.requests import DownloadRequest
from app.models.responses import BaseResponse
from app.services.spotiflac_service import execute_download, find_spotiflac, log_downloaded_files
from app.services.file_service import get_downloaded_files
from app.utils.validators import is_spotify_url
from app.config import settings

router = APIRouter(prefix="/download", tags=["Download"])


@router.post("/", response_model=BaseResponse)
async def trigger_download(req: DownloadRequest, bg_tasks: BackgroundTasks):
    if not is_spotify_url(str(req.url)):
        raise HTTPException(status_code=400, detail="Not a valid Spotify URL")

    bg_tasks.add_task(execute_download, req)
    return BaseResponse(message="Download queued successfully")


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
