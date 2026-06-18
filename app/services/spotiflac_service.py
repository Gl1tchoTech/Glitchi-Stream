import asyncio
import shlex
from app.config import settings
from app.utils.logger import logger
from app.models.requests import DownloadRequest


async def execute_download(req: DownloadRequest) -> None:
    """
    Runs SpotiFLAC as a subprocess (CLI).
    Avoids import issues with Python version incompatibilities.
    """
    logger.info(f"Starting download: {req.url}")

    cmd_parts = [
        "spotiflac",
        shlex.quote(str(req.url)),
        shlex.quote(settings.DOWNLOAD_DIR),
    ]

    if req.services:
        cmd_parts.extend(["--service", *req.services])
    if req.quality:
        cmd_parts.extend(["--quality", req.quality])

    cmd = " ".join(cmd_parts)

    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            err_msg = stderr.decode().strip()
            logger.error(f"Download failed for {req.url}: {err_msg}")
        else:
            out_msg = stdout.decode().strip()
            logger.info(f"Download complete: {req.url} — {out_msg}")

    except Exception as e:
        logger.error(f"Download error for {req.url}: {e}")
