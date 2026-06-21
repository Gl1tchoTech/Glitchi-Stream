import asyncio
import os
import shutil
import tempfile
from typing import Optional, Callable, Awaitable
from app.config import settings
from app.utils.logger import logger
from app.models.requests import DownloadRequest


def find_spotiflac() -> str | None:
    """Find the spotiflac binary on the system."""
    binary = shutil.which("spotiflac")
    if binary:
        return binary
    if os.name == "nt":
        for name in ("spotiflac.exe", "spotiflac"):
            path = shutil.which(name)
            if path:
                return path
    return None


async def execute_download(req: DownloadRequest) -> None:
    """
    Runs SpotiFLAC as a subprocess (backward-compat, no progress tracking).
    Uses create_subprocess_exec for safer cross-platform execution.
    """
    logger.info(f"Starting download: {req.url}")

    spotiflac_bin = find_spotiflac()
    if not spotiflac_bin:
        logger.error(
            "SpotiFLAC binary not found in PATH. "
            "Install it with: pip install spotiflac"
        )
        return

    cmd_args = [
        spotiflac_bin,
        str(req.url),
        settings.DOWNLOAD_DIR,
    ]

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

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=float(timeout)
            )
        except asyncio.TimeoutError:
            logger.error(
                f"Download timed out after {timeout}s for {req.url}"
            )
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                logger.error(f"Process did not terminate after kill for {req.url}")
            return

        if proc.returncode != 0:
            err_msg = stderr.decode().strip() or "Unknown error"
            logger.error(
                f"Download failed (exit {proc.returncode}) for {req.url}: {err_msg}"
            )
        else:
            out_msg = stdout.decode().strip()
            logger.info(f"Download complete: {req.url} — {out_msg}")
            log_downloaded_files()

    except FileNotFoundError:
        logger.error(
            f"SpotiFLAC binary not found at '{spotiflac_bin}'. "
            "Install it with: pip install spotiflac"
        )
    except Exception as e:
        logger.error(f"Download error for {req.url}: {type(e).__name__}: {e}")


async def execute_download_with_progress(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """
    Runs SpotiFLAC in an isolated temp directory with progress callbacks.

    Args:
        req: Download request with URL, quality, services.
        on_progress: Async callback(stage: str, detail: str) for progress updates.

    Returns:
        The final filename of the downloaded file, or None on failure.
    """
    logger.info(f"Starting download with progress: {req.url}")

    spotiflac_bin = find_spotiflac()
    if not spotiflac_bin:
        if on_progress:
            await on_progress("failed", "SpotiFLAC binary not found. Install with: pip install spotiflac")
        logger.error("SpotiFLAC binary not found in PATH.")
        return None

    # Create an isolated temp directory for this download
    temp_dir = tempfile.mkdtemp(prefix="spotiflac_", dir=settings.DOWNLOAD_DIR)

    cmd_args = [
        spotiflac_bin,
        str(req.url),
        temp_dir,
    ]

    if req.services:
        cmd_args.extend(["--service", *req.services])
    if req.quality:
        cmd_args.extend(["--quality", req.quality])

    timeout = req.timeout_s if req.timeout_s and req.timeout_s >= 30 else 600

    try:
        if on_progress:
            await on_progress("downloading", "Starting SpotiFLAC...")

        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        if on_progress:
            await on_progress("downloading", "Downloading from Spotify...")

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=float(timeout)
            )
        except asyncio.TimeoutError:
            logger.error(f"Download timed out after {timeout}s for {req.url}")
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                pass
            if on_progress:
                await on_progress("failed", f"Download timed out after {timeout}s")
            # Clean up temp dir
            _cleanup_temp_dir(temp_dir)
            return None

        if proc.returncode != 0:
            err_msg = stderr.decode().strip() or "Unknown error"
            logger.error(f"Download failed (exit {proc.returncode}) for {req.url}: {err_msg}")
            if on_progress:
                await on_progress("failed", err_msg[:200])
            _cleanup_temp_dir(temp_dir)
            return None

        # Success! Find the downloaded file in the temp directory
        if on_progress:
            await on_progress("processing", "Processing downloaded file...")

        filename = _find_and_move_file(temp_dir, settings.DOWNLOAD_DIR)

        if filename:
            if on_progress:
                await on_progress("complete", filename)
            logger.info(f"Download complete: {req.url} -> {filename}")
            log_downloaded_files()
            return filename
        else:
            if on_progress:
                await on_progress("failed", "Download completed but no audio file found")
            logger.error(f"No audio file found after download for {req.url}")
            _cleanup_temp_dir(temp_dir)
            return None

    except FileNotFoundError:
        if on_progress:
            await on_progress("failed", f"SpotiFLAC binary not found: {spotiflac_bin}")
        logger.error(f"SpotiFLAC binary not found at '{spotiflac_bin}'.")
        _cleanup_temp_dir(temp_dir)
        return None
    except Exception as e:
        if on_progress:
            await on_progress("failed", f"{type(e).__name__}: {e}")
        logger.error(f"Download error for {req.url}: {type(e).__name__}: {e}")
        _cleanup_temp_dir(temp_dir)
        return None


def _find_and_move_file(temp_dir: str, dest_dir: str) -> Optional[str]:
    """Find the first audio file in temp_dir and move it to dest_dir.

    Returns the relative filename (from dest_dir), or None.
    """
    audio_exts = {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus", ".aac"}
    try:
        for fn in os.listdir(temp_dir):
            if fn == ".gitkeep":
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext in audio_exts:
                src_path = os.path.join(temp_dir, fn)
                # Ensure unique name in destination
                dest_path = os.path.join(dest_dir, fn)
                if os.path.exists(dest_path):
                    base, ext = os.path.splitext(fn)
                    dest_path = os.path.join(dest_dir, f"{base}_{os.urandom(4).hex()}{ext}")
                shutil.move(src_path, dest_path)
                # Clean up temp dir
                _cleanup_temp_dir(temp_dir)
                return os.path.relpath(dest_path, dest_dir)
    except Exception as e:
        logger.error(f"Error moving file from temp dir: {e}")
    _cleanup_temp_dir(temp_dir)
    return None


def _cleanup_temp_dir(temp_dir: str) -> None:
    """Remove a temp directory and its contents."""
    try:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
    except Exception:
        pass


def log_downloaded_files():
    """Log what files are currently in the download directory."""
    try:
        files = os.listdir(settings.DOWNLOAD_DIR)
        audio_files = [
            f for f in files
            if f.endswith((".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus"))
            and f != ".gitkeep"
        ]
        if audio_files:
            logger.info(
                f"Download directory now has {len(audio_files)} audio files: "
                f"{', '.join(audio_files[:5])}"
                + (f" and {len(audio_files) - 5} more..." if len(audio_files) > 5 else "")
            )
    except Exception:
        pass
