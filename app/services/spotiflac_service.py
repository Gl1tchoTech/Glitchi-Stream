import asyncio
import shlex
from app.config import settings
from app.utils.logger import logger
from app.models.requests import DownloadRequest


async def execute_download(req: DownloadRequest) -> None:
    logger.info(f"Starting download: {req.url}")
    cmd = f"spotiflac {shlex.quote(str(req.url))} {shlex.quote(settings.DOWNLOAD_DIR)}"
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.error(f"Download failed: {stderr.decode()}")
        else:
            logger.info(f"Download complete: {req.url}")
    except Exception as e:
        logger.error(f"Download error for {req.url}: {e}")
