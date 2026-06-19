import os
from typing import List
from app.config import settings
from app.models.responses import FileItem


def get_downloaded_files() -> List[FileItem]:
    files: List[FileItem] = []
    for root, _, filenames in os.walk(settings.DOWNLOAD_DIR):
        for f in filenames:
            if f == ".gitkeep":
                continue
            # Skip temporary/incomplete files
            if f.endswith((".tmp", ".part", ".crdownload", ".partial")):
                continue
            abs_path = os.path.join(root, f)
            rel_path = os.path.relpath(abs_path, settings.DOWNLOAD_DIR)
            size_mb = os.path.getsize(abs_path) / (1024 * 1024)
            _, ext = os.path.splitext(f)
            files.append(
                FileItem(
                    filename=rel_path,
                    size_mb=round(size_mb, 2),
                    extension=ext.lower(),
                )
            )
    return files


def get_file_path(filename: str) -> str:
    safe_path = os.path.abspath(os.path.join(settings.DOWNLOAD_DIR, filename))
    if not safe_path.startswith(os.path.abspath(settings.DOWNLOAD_DIR)):
        raise ValueError("Path traversal attempt blocked")
    if not os.path.exists(safe_path):
        raise FileNotFoundError(f"File not found: {filename}")
    return safe_path
