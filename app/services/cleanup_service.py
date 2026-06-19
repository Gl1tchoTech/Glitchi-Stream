import asyncio
import os
from app.config import settings
from app.utils.logger import logger

# Extensions that indicate temporary/incomplete downloads
_TEMP_EXTENSIONS = {
    ".tmp", ".part", ".crdownload", ".partial", ".download",
    ".incomplete", ".spotdl", ".temp", ".tmpfile", ".frag",
}


async def start_cleanup_task():
    """
    Clean up temp/incomplete files once at startup.
    Full downloaded audio files persist until the server is restarted.
    """
    try:
        removed = 0
        for root, _, files in os.walk(settings.DOWNLOAD_DIR):
            for f in files:
                if f == ".gitkeep":
                    continue
                _, ext = os.path.splitext(f)
                ext = ext.lower()
                # Only clean temporary/incomplete files, NOT completed audio files
                if ext in _TEMP_EXTENSIONS:
                    path = os.path.join(root, f)
                    os.remove(path)
                    removed += 1
                    logger.info(f"Cleaned up temp file: {f}")
        if removed > 0:
            logger.info(f"Startup cleanup complete: removed {removed} temp file(s)")
        else:
            logger.info("Startup cleanup: no temp files to remove")
    except Exception as e:
        logger.error(f"Cleanup error: {e}")
    # Task exits after one run — downloaded audio files persist until next restart
