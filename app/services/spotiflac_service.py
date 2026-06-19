import asyncio
import os
import shutil
import shlex
from app.config import settings
from app.utils.logger import logger
from app.models.requests import DownloadRequest


def find_spotiflac() -> str | None:
    """Find the spotiflac binary on the system."""
    # Try direct command name first
    binary = shutil.which("spotiflac")
    if binary:
        return binary
    # On Windows, try .exe extension and common paths
    if os.name == "nt":
        for name in ("spotiflac.exe", "spotiflac"):
            path = shutil.which(name)
            if path:
                return path
    return None


async def execute_download(req: DownloadRequest) -> None:
    """
    Runs SpotiFLAC as a subprocess.
    Uses create_subprocess_exec for safer cross-platform execution.
    Includes timeout and pre-flight binary check.
    """
    logger.info(f"Starting download: {req.url}")

    # Pre-flight: check if spotiflac is available
    spotiflac_bin = find_spotiflac()
    if not spotiflac_bin:
        logger.error(
            "SpotiFLAC binary not found in PATH. "
            "Install it with: pip install spotiflac"
        )
        return

    # Build command arguments (not shell-quoted — exec handles escaping)
    # SpotiFLAC embeds metadata by default from Spotify track info
    cmd_args = [
        spotiflac_bin,
        str(req.url),
        settings.DOWNLOAD_DIR,
    ]

    if req.services:
        cmd_args.extend(["--service", *req.services])
    if req.quality:
        cmd_args.extend(["--quality", req.quality])

    # Use request timeout, with a generous default for large music files
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
            # Look for the downloaded file to confirm
            log_downloaded_files()

    except FileNotFoundError:
        logger.error(
            f"SpotiFLAC binary not found at '{spotiflac_bin}'. "
            "Install it with: pip install spotiflac"
        )
    except Exception as e:
        logger.error(f"Download error for {req.url}: {type(e).__name__}: {e}")


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
