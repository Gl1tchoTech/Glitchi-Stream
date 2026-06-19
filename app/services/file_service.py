import os
import time
from typing import List
from app.config import settings
from app.models.responses import FileItem

# Extensions that indicate temporary/incomplete downloads
_TEMP_EXTENSIONS = {
    ".tmp", ".part", ".crdownload", ".partial", ".download",
    ".incomplete", ".spotdl", ".temp", ".tmpfile", ".frag",
}

# Only these are actual playable audio file extensions
_AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus", 
    ".aac", ".wma", ".aiff", ".alac",
}


def _is_temp_or_non_audio(filename: str, abs_path: str) -> bool:
    """
    Check if a file should be hidden from the My Files listing.
    Returns True if the file is temporary, non-audio, or should be excluded.
    """
    _, ext = os.path.splitext(filename)
    ext = ext.lower()

    # Skip known temp extensions
    if ext in _TEMP_EXTENSIONS:
        return True

    # Only show known audio files (skip .zip, .txt, .json, etc.)
    if ext not in _AUDIO_EXTENSIONS and ext:
        return True

    # Skip very small files (< 100KB) that might be partial downloads
    try:
        if os.path.getsize(abs_path) < 102400:
            return True
    except OSError:
        return True

    return False


def get_downloaded_files() -> List[FileItem]:
    files: List[FileItem] = []
    for root, _, filenames in os.walk(settings.DOWNLOAD_DIR):
        for f in filenames:
            if f == ".gitkeep":
                continue
            abs_path = os.path.join(root, f)

            # Skip temp files and non-audio files
            if _is_temp_or_non_audio(f, abs_path):
                continue

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
