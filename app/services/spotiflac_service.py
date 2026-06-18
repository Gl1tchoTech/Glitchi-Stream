import asyncio
from fastapi.concurrency import run_in_threadpool
from backend import SpotiFLAC
from app.config import settings
from app.utils.logger import logger
from app.models.requests import DownloadRequest


async def execute_download(req: DownloadRequest) -> None:
    """
    Runs SpotiFLAC in a thread pool since it's synchronous/blocking.
    This is called as a background task from the download endpoint.
    """
    logger.info(f"Starting download: {req.url}")
    try:
        await run_in_threadpool(
            SpotiFLAC,
            url=str(req.url),
            output_dir=settings.DOWNLOAD_DIR,
            services=req.services,
            quality=req.quality,
            timeout_s=req.timeout_s,
            track_max_retries=req.track_max_retries,
        )
        logger.info(f"Download complete: {req.url}")
    except Exception as e:
        logger.error(f"Download failed for {req.url}: {e}")
