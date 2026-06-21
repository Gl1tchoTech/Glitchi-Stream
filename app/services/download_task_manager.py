"""Download task manager - tracks SpotiFLAC download progress in memory.

Uses a simple dict for task storage (single-process deployment).
Provides polling-based progress updates for the frontend.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional
from app.utils.logger import logger

# Maximum concurrent SpotiFLAC downloads to prevent resource exhaustion
_MAX_CONCURRENT = 3
# Auto-cleanup tasks older than this (seconds)
_TASK_TTL = 2 * 3600  # 2 hours
# Cleanup interval
_CLEANUP_INTERVAL = 600  # 10 minutes


@dataclass
class DownloadTask:
    """Represents a single download task's state."""
    task_id: str
    url: str
    status: str  # pending | downloading | processing | complete | failed
    stage: str = ""  # Human-readable stage description
    filename: str = ""  # Final filename (set when complete)
    error: str = ""  # Error message (set when failed)
    created_at: float = field(default_factory=time.time)
    _done_event: asyncio.Event = field(default_factory=asyncio.Event)


class DownloadTaskManager:
    """In-memory task tracker with concurrency control and cleanup."""

    def __init__(self):
        self._tasks: dict[str, DownloadTask] = {}
        self._semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
        self._cleanup_task: Optional[asyncio.Task] = None

    def create_task(self, url: str) -> DownloadTask:
        """Create a new task and return it."""
        task_id = uuid.uuid4().hex[:12]
        task = DownloadTask(
            task_id=task_id,
            url=str(url),
            status="pending",
            stage="Queued...",
        )
        self._tasks[task_id] = task
        logger.info(f"Download task created: {task_id} for {url}")
        return task

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        """Get a task by ID, returns None if not found."""
        return self._tasks.get(task_id)

    def update_task(self, task_id: str, **kwargs) -> None:
        """Update task fields and signal completion if done."""
        task = self._tasks.get(task_id)
        if not task:
            return
        for key, value in kwargs.items():
            if hasattr(task, key):
                setattr(task, key, value)
        if task.status in ("complete", "failed"):
            task._done_event.set()
            logger.info(f"Download task {task_id}: {task.status} - {task.filename or task.error}")

    async def wait_for_task(self, task_id: str, timeout: float = 600) -> None:
        """Wait for a task to complete or fail."""
        task = self._tasks.get(task_id)
        if not task:
            return
        try:
            await asyncio.wait_for(task._done_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self.update_task(task_id, status="failed", error="Download timed out")

    def get_semaphore(self) -> asyncio.Semaphore:
        """Get the concurrency-limiting semaphore."""
        return self._semaphore

    def cleanup_old_tasks(self) -> int:
        """Remove tasks older than TTL. Returns count removed."""
        now = time.time()
        stale_ids = [
            tid for tid, t in self._tasks.items()
            if now - t.created_at > _TASK_TTL
        ]
        for tid in stale_ids:
            del self._tasks[tid]
        if stale_ids:
            logger.info(f"Cleaned up {len(stale_ids)} stale download tasks")
        return len(stale_ids)

    async def start_cleanup_loop(self) -> None:
        """Background loop that periodically cleans up old tasks."""
        while True:
            await asyncio.sleep(_CLEANUP_INTERVAL)
            self.cleanup_old_tasks()


# Global singleton
task_manager = DownloadTaskManager()
