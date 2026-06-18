import asyncio
import os
import time
from app.config import settings
from app.utils.logger import logger


async def start_cleanup_task():
    """
    Periodically deletes files older than CLEANUP_AGE_HOURS.
    Runs as a background coroutine on app startup.
    """
    while True:
        try:
            now = time.time()
            cutoff = now - (settings.CLEANUP_AGE_HOURS * 3600)
            for root, _, files in os.walk(settings.DOWNLOAD_DIR):
                for f in files:
                    if f == ".gitkeep":
                        continue
                    path = os.path.join(root, f)
                    if os.path.getmtime(path) < cutoff:
                        os.remove(path)
                        logger.info(f"Cleaned up old file: {f}")
        except Exception as e:
            logger.error(f"Cleanup error: {e}")
        await asyncio.sleep(3600)  # Run every hour
