import asyncio
import os
import re
import shutil
import tempfile
from typing import Optional, Callable, Awaitable
import httpx
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC, TDRC, TRCK
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggvorbis import OggVorbis
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


# ── Spotify URL parsing ─────────────────────────────────────────────

_SPOTIFY_TRACK_RE = re.compile(r"https?://open\.spotify\.com/(?:intl-\w+/)?track/([A-Za-z0-9]+)")
_SPOTIFY_ALBUM_RE = re.compile(r"https?://open\.spotify\.com/(?:intl-\w+/)?album/([A-Za-z0-9]+)")


def _extract_track_id(url: str) -> Optional[str]:
    """Extract the track ID from a Spotify URL. Returns None if not a track URL."""
    m = _SPOTIFY_TRACK_RE.search(url)
    return m.group(1) if m else None


def _extract_album_id(url: str) -> Optional[str]:
    """Extract the album ID from a Spotify URL."""
    m = _SPOTIFY_ALBUM_RE.search(url)
    return m.group(1) if m else None


# ── Metadata fetch via SpotAPI ──────────────────────────────────────

async def _fetch_track_metadata(track_id: str) -> Optional[dict]:
    """Fetch track metadata from SpotAPI in a thread (SpotAPI is sync).

    Returns a dict with: title, artist, album, cover_url, year, track_number, genre.
    """
    try:
        from spotapi import Song

        def _fetch():
            song = Song()
            info = song.get_track_info(track_id)
            if not info or not isinstance(info, dict):
                return None
            track_union = info.get("data", {}).get("trackUnion", {})
            if not track_union:
                return None

            title = track_union.get("name", "")
            # Artists
            artists_items = track_union.get("artists", {}).get("items", [])
            artist = ", ".join(
                a.get("profile", {}).get("name", "")
                for a in artists_items
            )
            # Album
            album_data = track_union.get("albumOfTrack", {})
            album = album_data.get("name", "")
            # Cover art - pick best resolution
            cover_sources = album_data.get("coverArt", {}).get("sources", [])
            cover_url = ""
            if cover_sources:
                best = max(cover_sources, key=lambda s: s.get("width", 0) * s.get("height", 0))
                cover_url = best.get("url", "")
            # Duration
            duration_ms = track_union.get("duration", {}).get("totalMilliseconds", 0)
            # Year
            year = str(album_data.get("date", {}).get("year", ""))
            # Track number
            track_number = track_union.get("trackNumber", 0)
            # Genre — not always available
            genre = ""

            return {
                "title": title,
                "artist": artist,
                "album": album,
                "cover_url": cover_url,
                "duration_ms": duration_ms,
                "year": year,
                "track_number": track_number,
                "genre": genre,
            }

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _fetch)
    except Exception as e:
        logger.error(f"SpotAPI metadata fetch error for {track_id}: {type(e).__name__}: {e}")
        return None


# ── Cover art download ──────────────────────────────────────────────

async def _download_cover_art(cover_url: str) -> Optional[bytes]:
    """Download cover art image bytes from a URL."""
    if not cover_url:
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            resp = await client.get(cover_url)
            if resp.status_code == 200:
                # Only download if size is reasonable (< 5MB)
                if len(resp.content) < 5 * 1024 * 1024:
                    return resp.content
            return None
    except Exception as e:
        logger.warning(f"Failed to download cover art: {e}")
        return None


# ── Metadata injection via mutagen ───────────────────────────────────

def _sanitize_filename(artist: str, title: str) -> str:
    """Create a clean filename: 'Artist - Title' (sanitized for filesystems)."""
    raw = f"{artist} - {title}" if artist else title
    # Remove/replace characters unsafe for filenames
    safe = re.sub(r'[<>:"/\\|?*]', '', raw)
    # Collapse whitespace
    safe = re.sub(r'\s+', ' ', safe).strip()
    # Strip trailing dots/spaces (illegal on Windows)
    safe = safe.rstrip('. ')
    # Limit length
    if len(safe) > 180:
        safe = safe[:177] + "..."
    return safe


def _inject_metadata(filepath: str, metadata: dict, cover_data: Optional[bytes] = None) -> bool:
    """Embed metadata tags into an audio file using mutagen.

    Handles MP3 (ID3), FLAC (Vorbis), M4A/MP4, OGG (Vorbis), and generic.
    """
    ext = os.path.splitext(filepath)[1].lower()
    title = metadata.get("title", "")
    artist = metadata.get("artist", "")
    album = metadata.get("album", "")
    year = metadata.get("year", "")
    track_number = metadata.get("track_number", 0)

    try:
        if ext == ".mp3":
            _inject_mp3(filepath, title, artist, album, year, track_number, cover_data)
        elif ext == ".flac":
            _inject_flac(filepath, title, artist, album, year, track_number, cover_data)
        elif ext in (".m4a", ".mp4"):
            _inject_mp4(filepath, title, artist, album, year, track_number, cover_data)
        elif ext in (".ogg", ".opus"):
            _inject_ogg(filepath, title, artist, album, year, track_number, cover_data)
        else:
            # Generic fallback (WAV, etc. — limited tag support)
            audio = MutagenFile(filepath)
            if audio is not None:
                if hasattr(audio, "tags") and audio.tags is not None:
                    audio.tags["title"] = title
                    audio.tags["artist"] = artist
                    audio.tags["album"] = album
                    audio.save()
            logger.info(f"Generic metadata injected for: {os.path.basename(filepath)}")
            return True

        logger.info(f"Metadata injected for: {os.path.basename(filepath)} — {artist} - {title}")
        return True
    except Exception as e:
        logger.error(f"Metadata injection failed for {filepath}: {type(e).__name__}: {e}")
        return False


def _inject_mp3(filepath: str, title: str, artist: str, album: str,
                year: str, track_number: int, cover_data: Optional[bytes]) -> None:
    """Inject ID3v2 tags into an MP3 file."""
    try:
        audio = ID3(filepath)
    except Exception:
        audio = ID3()

    if title:
        audio["TIT2"] = TIT2(encoding=3, text=title)
    if artist:
        audio["TPE1"] = TPE1(encoding=3, text=artist)
    if album:
        audio["TALB"] = TALB(encoding=3, text=album)
    if year:
        audio["TDRC"] = TDRC(encoding=3, text=year)
    if track_number:
        audio["TRCK"] = TRCK(encoding=3, text=str(track_number))

    # Cover art
    if cover_data:
        mime = _guess_mime(cover_data)
        audio["APIC"] = APIC(
            encoding=3,
            mime=mime,
            type=3,  # front cover
            desc="Cover",
            data=cover_data,
        )

    audio.save(filepath, v2_version=3)


def _inject_flac(filepath: str, title: str, artist: str, album: str,
                 year: str, track_number: int, cover_data: Optional[bytes]) -> None:
    """Inject Vorbis comments + cover picture into a FLAC file."""
    audio = FLAC(filepath)

    if title:
        audio["title"] = title
    if artist:
        audio["artist"] = artist
    if album:
        audio["album"] = album
    if year:
        audio["date"] = year
    if track_number:
        audio["tracknumber"] = str(track_number)

    # Cover art as FLAC Picture block
    if cover_data:
        pic = Picture()
        pic.type = 3  # front cover
        pic.mime = _guess_mime(cover_data)
        pic.desc = "Cover"
        pic.data = cover_data
        if pic.width == 0 and pic.height == 0:
            pic.width = 300
            pic.height = 300
        audio.add_picture(pic)

    audio.save()


def _inject_mp4(filepath: str, title: str, artist: str, album: str,
                year: str, track_number: int, cover_data: Optional[bytes]) -> None:
    """Inject MP4 tags into an M4A file."""
    audio = MP4(filepath)

    if title:
        audio["\xa9nam"] = title
    if artist:
        audio["\xa9ART"] = artist
    if album:
        audio["\xa9alb"] = album
    if year:
        audio["\xa9day"] = year
    if track_number:
        audio["trkn"] = [(track_number, 0)]

    # Cover art
    if cover_data:
        fmt = MP4Cover.FORMAT_JPEG if cover_data[:3] == b"\xff\xd8\xff" else MP4Cover.FORMAT_PNG
        audio["covr"] = [MP4Cover(cover_data, imageformat=fmt)]

    audio.save()


def _inject_ogg(filepath: str, title: str, artist: str, album: str,
                year: str, track_number: int, cover_data: Optional[bytes]) -> None:
    """Inject Vorbis comments into an OGG/Opus file."""
    audio = OggVorbis(filepath)

    if title:
        audio["title"] = title
    if artist:
        audio["artist"] = artist
    if album:
        audio["album"] = album
    if year:
        audio["date"] = year
    if track_number:
        audio["tracknumber"] = str(track_number)

    # Mutagen OggVorbis supports METADATA_BLOCK_PICTURE for cover art
    if cover_data:
        import base64
        pic = Picture()
        pic.type = 3  # front cover
        pic.mime = _guess_mime(cover_data)
        pic.desc = "Cover"
        pic.data = cover_data
        if pic.width == 0 and pic.height == 0:
            pic.width = 300
            pic.height = 300
        pic_data = base64.b64encode(pic.write()).decode("ascii")
        audio["metadata_block_picture"] = pic_data

    audio.save()


def _guess_mime(data: bytes) -> str:
    """Guess MIME type from magic bytes."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"  # default


# ── Full download + metadata pipeline ────────────────────────────────

async def _process_metadata(filepath: str, url: str,
                            on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None) -> str:
    """Fetch metadata from SpotAPI, download cover art, embed tags, rename file.

    Returns the new filename (relative path from DOWNLOAD_DIR), or the original on failure.
    """
    track_id = _extract_track_id(url)
    if not track_id:
        logger.warning(f"Could not extract track ID from URL: {url}")
        return os.path.relpath(filepath, settings.DOWNLOAD_DIR)

    if on_progress:
        await on_progress("processing", "Fetching track metadata...")

    metadata = await _fetch_track_metadata(track_id)
    if not metadata:
        logger.warning(f"No metadata found for track ID: {track_id}")
        return os.path.relpath(filepath, settings.DOWNLOAD_DIR)

    if on_progress:
        await on_progress("processing", "Downloading cover art...")

    cover_data = None
    if metadata.get("cover_url"):
        cover_data = await _download_cover_art(metadata["cover_url"])

    if on_progress:
        await on_progress("processing", "Embedding metadata tags...")

    # Inject metadata tags
    _inject_metadata(filepath, metadata, cover_data)

    # Rename file to clean format: "Artist - Title.ext"
    ext = os.path.splitext(filepath)[1].lower()
    safe_name = _sanitize_filename(metadata.get("artist", ""), metadata.get("title", ""))
    new_name = f"{safe_name}{ext}"
    new_path = os.path.join(settings.DOWNLOAD_DIR, new_name)

    # Avoid overwriting existing files
    if os.path.exists(new_path) and os.path.abspath(new_path) != os.path.abspath(filepath):
        base, e = os.path.splitext(new_name)
        new_name = f"{base}_{os.urandom(3).hex()}{e}"
        new_path = os.path.join(settings.DOWNLOAD_DIR, new_name)

    try:
        os.rename(filepath, new_path)
        logger.info(f"Renamed: {os.path.basename(filepath)} -> {new_name}")
        return os.path.relpath(new_path, settings.DOWNLOAD_DIR)
    except OSError as e:
        logger.warning(f"Failed to rename file: {e}")
        return os.path.relpath(filepath, settings.DOWNLOAD_DIR)


# ── Backward-compat download (no progress, no metadata) ─────────────

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


# ── Progress-tracked download with metadata injection ────────────────

async def execute_download_with_progress(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """
    Runs SpotiFLAC in an isolated temp directory with progress callbacks.
    After download, fetches metadata from SpotAPI, downloads cover art,
    embeds all tags via mutagen, and renames the file.

    Args:
        req: Download request with URL, quality, services.
        on_progress: Async callback(stage: str, detail: str) for progress updates.

    Returns:
        The final filename (relative to DOWNLOAD_DIR), or None on failure.
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

        filepath = _find_and_move_file(temp_dir, settings.DOWNLOAD_DIR)
        if not filepath:
            if on_progress:
                await on_progress("failed", "Download completed but no audio file found")
            logger.error(f"No audio file found after download for {req.url}")
            _cleanup_temp_dir(temp_dir)
            return None

        abs_path = os.path.join(settings.DOWNLOAD_DIR, filepath)

        # Inject metadata tags and rename file using SpotAPI
        final_filename = await _process_metadata(abs_path, str(req.url), on_progress)

        if on_progress:
            await on_progress("complete", final_filename)

        logger.info(f"Download complete: {req.url} -> {final_filename}")
        log_downloaded_files()
        return final_filename

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


# ── File helpers ─────────────────────────────────────────────────────

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
                dest_path = os.path.join(dest_dir, fn)
                if os.path.exists(dest_path):
                    base, ext = os.path.splitext(fn)
                    dest_path = os.path.join(dest_dir, f"{base}_{os.urandom(4).hex()}{ext}")
                shutil.move(src_path, dest_path)
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
