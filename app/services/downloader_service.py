"""
Unified Downloader Service — dispatches to the configured downloader.

Three engines:
  - ``spotiflac`` — SpotiFLAC subprocess (lossless from Qobuz/Tidal)
  - ``ytdlp``    — yt-dlp searches YouTube, downloads best audio
  - ``spotdl``   — SpotDL CLI subprocess (Spotify → YouTube → tagged audio)

All engines share the same metadata-injection pipeline (SpotAPI → mutagen).
"""

import asyncio
import difflib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Optional, Callable, Awaitable

import httpx
import yt_dlp
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC, TDRC, TRCK
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggvorbis import OggVorbis

from app.config import settings
from app.utils.logger import logger
from app.models.requests import DownloadRequest


# ═══════════════════════════════════════════════════════════════════════
# Binary / availability checks
# ═══════════════════════════════════════════════════════════════════════

# Module-level ffmpeg availability cache (checked once at import)
_FFMPEG_AVAILABLE = bool(shutil.which("ffmpeg") or shutil.which("ffmpeg.exe"))

def _find_binary(*names: str) -> Optional[str]:
    """Find the first available binary on PATH."""
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


def _module_is_importable(module_name: str) -> bool:
    """Check if a Python module can be imported."""
    try:
        __import__(module_name)
        return True
    except ImportError:
        return False


def is_spotiflac_available() -> bool:
    """SpotiFLAC is a CLI tool, not a Python module.
    Check PATH binary and also the pip-installed scripts directory.
    Also requires ffmpeg on PATH."""
    # SpotiFLAC needs ffmpeg for audio processing
    if not _FFMPEG_AVAILABLE:
        return False
    if _find_binary("spotiflac", "spotiflac.exe"):
        return True
    # Windows: pip installs scripts to PythonXY/Scripts/
    scripts_dir = os.path.join(os.path.dirname(sys.executable), "Scripts")
    for name in ("spotiflac", "spotiflac.exe"):
        if os.path.isfile(os.path.join(scripts_dir, name)):
            return True
    # Also check the user-site scripts directory
    try:
        import site
        user_scripts = os.path.join(site.getusersitepackages().replace("site-packages", "Scripts"))
        for name in ("spotiflac", "spotiflac.exe"):
            if os.path.isfile(os.path.join(user_scripts, name)):
                return True
    except Exception:
        pass
    return False


def is_ytdlp_available() -> bool:
    return _find_binary("yt-dlp", "yt-dlp.exe") is not None or _module_is_importable("yt_dlp")


def is_spotdl_available() -> bool:
    """SpotDL uses yt-dlp under the hood and requires ffmpeg for audio processing."""
    if not _FFMPEG_AVAILABLE:
        return False
    return _find_binary("spotdl", "spotdl.exe") is not None or _module_is_importable("spotdl")


def get_available_downloaders() -> list[str]:
    """Return list of downloader slugs that are installed and ready."""
    available = []
    if is_spotiflac_available():
        available.append("spotiflac")
    if is_ytdlp_available():
        available.append("ytdlp")
    if is_spotdl_available():
        available.append("spotdl")
    return available


# ═══════════════════════════════════════════════════════════════════════
# Spotify URL parsing
# ═══════════════════════════════════════════════════════════════════════

_SPOTIFY_TRACK_RE = re.compile(
    r"https?://open\.spotify\.com/(?:intl-\w+/)?track/([A-Za-z0-9]+)"
)
_SPOTIFY_ALBUM_RE = re.compile(
    r"https?://open\.spotify\.com/(?:intl-\w+/)?album/([A-Za-z0-9]+)"
)


def extract_track_id(url: str) -> Optional[str]:
    m = _SPOTIFY_TRACK_RE.search(url)
    return m.group(1) if m else None


def extract_album_id(url: str) -> Optional[str]:
    m = _SPOTIFY_ALBUM_RE.search(url)
    return m.group(1) if m else None


# ═══════════════════════════════════════════════════════════════════════
# Metadata pipeline (shared by all downloaders)
# ═══════════════════════════════════════════════════════════════════════

async def _fetch_track_metadata(track_id: str) -> Optional[dict]:
    """Fetch track metadata from SpotAPI (runs in thread executor).

    Returns dict with: title, artist, album, cover_url, year, track_number.
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
            artists_items = track_union.get("artists", {}).get("items", [])
            artist = ", ".join(
                a.get("profile", {}).get("name", "")
                for a in artists_items
            )
            album_data = track_union.get("albumOfTrack", {})
            album = album_data.get("name", "")
            cover_sources = album_data.get("coverArt", {}).get("sources", [])
            cover_url = ""
            if cover_sources:
                best = max(cover_sources, key=lambda s: s.get("width", 0) * s.get("height", 0))
                cover_url = best.get("url", "")
            year = str(album_data.get("date", {}).get("year", ""))
            track_number = track_union.get("trackNumber", 0)

            return {
                "title": title,
                "artist": artist,
                "album": album,
                "cover_url": cover_url,
                "year": year,
                "track_number": track_number,
            }

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _fetch)
    except Exception as e:
        logger.error(f"SpotAPI metadata fetch error for {track_id}: {type(e).__name__}: {e}")
        return None


async def _fetch_metadata_fallback(url: str) -> Optional[dict]:
    """Fallback: extract track ID and try query_songs with it.

    Used when direct get_track_info fetch fails.
    """
    try:
        from spotapi import Song
        track_id = extract_track_id(url)
        if not track_id:
            return None

        def _search():
            song = Song()
            # Search using just the track ID as a query
            results = song.query_songs(track_id, limit=5)
            if not results or not isinstance(results, dict):
                return None
            search_v2 = results.get("data", {}).get("searchV2", {})
            items = search_v2.get("tracksV2", {}).get("items", [])
            if not items:
                return None
            data = items[0].get("item", {}).get("data", {})
            if not data:
                return None

            title = data.get("name", "")
            artists_items = data.get("artists", {}).get("items", [])
            artist = ", ".join(
                a.get("profile", {}).get("name", "")
                for a in artists_items
            )
            album_data = data.get("albumOfTrack", {})
            album = album_data.get("name", "")
            cover_sources = album_data.get("coverArt", {}).get("sources", [])
            cover_url = ""
            if cover_sources:
                best = max(cover_sources, key=lambda s: s.get("width", 0) * s.get("height", 0))
                cover_url = best.get("url", "")
            year = str(album_data.get("date", {}).get("year", ""))
            track_number = data.get("trackNumber", 0)

            return {
                "title": title,
                "artist": artist,
                "album": album,
                "cover_url": cover_url,
                "year": year,
                "track_number": track_number,
            }

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _search)
    except Exception as e:
        logger.error(f"Fallback metadata search error: {type(e).__name__}: {e}")
        return None


async def fetch_metadata(url: str) -> Optional[dict]:
    """Fetch metadata for a Spotify URL, with fallback.

    Tries direct track lookup first.  If that fails entirely (no title),
    falls back to query_songs search by track ID.  Does NOT enrich artist
    separately — a missing artist is better than the wrong artist.
    """
    track_id = extract_track_id(url)
    if track_id:
        metadata = await _fetch_track_metadata(track_id)
        if metadata and metadata.get("title"):
            logger.info(f"Metadata fetched via SpotAPI for: {metadata.get('artist')} - {metadata.get('title')}")
            return metadata
        logger.warning(f"Direct metadata fetch failed for track {track_id}, trying fallback...")

    # Fallback: search by URL as query
    metadata = await _fetch_metadata_fallback(url)
    if metadata and metadata.get("title"):
        logger.info(f"Metadata fetched via fallback for: {metadata.get('artist')} - {metadata.get('title')}")
        return metadata

    logger.warning(f"All metadata fetch attempts failed for: {url}")
    return None


async def _download_cover_art(cover_url: str) -> Optional[bytes]:
    if not cover_url:
        return None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            resp = await client.get(cover_url)
            if resp.status_code == 200 and len(resp.content) < 5 * 1024 * 1024:
                return resp.content
            return None
    except Exception as e:
        logger.warning(f"Failed to download cover art: {e}")
        return None


# ── Sanitize filename ────────────────────────────────────────────────

def sanitize_filename(artist: str, title: str) -> str:
    raw = f"{artist} - {title}" if artist else title
    safe = re.sub(r'[<>:"/\\|?*]', '', raw)
    safe = re.sub(r'\s+', ' ', safe).strip()
    safe = safe.rstrip('. ')
    if len(safe) > 180:
        safe = safe[:177] + "..."
    return safe


# ── MIME guessing ────────────────────────────────────────────────────

def _guess_mime(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


# ── Metadata injection dispatcher ────────────────────────────────────

def inject_metadata(filepath: str, metadata: dict, cover_data: Optional[bytes] = None) -> bool:
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
        elif ext == ".webm":
            _inject_webm(filepath, title, artist, album, year, track_number, cover_data)
            logger.info(f"Metadata injected: {os.path.basename(filepath)} — {artist} - {title}")
            return True
        else:
            audio = MutagenFile(filepath)
            if audio is not None and hasattr(audio, "tags") and audio.tags is not None:
                audio.tags["title"] = title
                audio.tags["artist"] = artist
                audio.tags["album"] = album
                audio.save()
            logger.info(f"Generic metadata injected for: {os.path.basename(filepath)}")
            return True

        logger.info(f"Metadata injected: {os.path.basename(filepath)} — {artist} - {title}")
        return True
    except Exception as e:
        logger.error(f"Metadata injection failed for {filepath}: {type(e).__name__}: {e}")
        return False


# ── Format-specific injectors ────────────────────────────────────────

def _inject_mp3(filepath, title, artist, album, year, track_number, cover_data):
    try:
        audio = ID3(filepath)
    except Exception:
        audio = ID3()
    if title:
        audio["TIT2"] = TIT2(encoding=3, text=title)
    # Always write artist — fall back to "Unknown Artist" so the tag is never missing
    audio["TPE1"] = TPE1(encoding=3, text=artist or "Unknown Artist")
    if album:
        audio["TALB"] = TALB(encoding=3, text=album)
    if year:
        audio["TDRC"] = TDRC(encoding=3, text=year)
    if track_number:
        audio["TRCK"] = TRCK(encoding=3, text=str(track_number))
    if cover_data:
        audio["APIC"] = APIC(encoding=3, mime=_guess_mime(cover_data), type=3, desc="Cover", data=cover_data)
    audio.save(filepath, v2_version=3)


def _inject_flac(filepath, title, artist, album, year, track_number, cover_data):
    audio = FLAC(filepath)
    if title:
        audio["title"] = title
    # Always write artist — fall back to "Unknown Artist"
    audio["artist"] = artist or "Unknown Artist"
    if album:
        audio["album"] = album
    if year:
        audio["date"] = year
    if track_number:
        audio["tracknumber"] = str(track_number)
    if cover_data:
        pic = Picture()
        pic.type = 3
        pic.mime = _guess_mime(cover_data)
        pic.desc = "Cover"
        pic.data = cover_data
        if pic.width == 0 and pic.height == 0:
            pic.width = 300
            pic.height = 300
        audio.add_picture(pic)
    audio.save()


def _inject_mp4(filepath, title, artist, album, year, track_number, cover_data):
    audio = MP4(filepath)
    if title:
        audio["\xa9nam"] = title
    # Always write artist — fall back to "Unknown Artist"
    audio["\xa9ART"] = artist or "Unknown Artist"
    if album:
        audio["\xa9alb"] = album
    if year:
        audio["\xa9day"] = year
    if track_number:
        audio["trkn"] = [(track_number, 0)]
    if cover_data:
        fmt = MP4Cover.FORMAT_JPEG if cover_data[:3] == b"\xff\xd8\xff" else MP4Cover.FORMAT_PNG
        audio["covr"] = [MP4Cover(cover_data, imageformat=fmt)]
    audio.save()


def _inject_ogg(filepath, title, artist, album, year, track_number, cover_data):
    import base64
    audio = OggVorbis(filepath)
    if title:
        audio["title"] = title
    # Always write artist — fall back to "Unknown Artist"
    audio["artist"] = artist or "Unknown Artist"
    if album:
        audio["album"] = album
    if year:
        audio["date"] = year
    if track_number:
        audio["tracknumber"] = str(track_number)
    if cover_data:
        pic = Picture()
        pic.type = 3
        pic.mime = _guess_mime(cover_data)
        pic.desc = "Cover"
        pic.data = cover_data
        if pic.width == 0 and pic.height == 0:
            pic.width = 300
            pic.height = 300
        audio["metadata_block_picture"] = base64.b64encode(pic.write()).decode("ascii")
    audio.save()


def _inject_webm(filepath, title, artist, album, year, track_number, cover_data):
    """Write Matroska/EBML tags directly into a .webm file.

    mutagen doesn't support WebM, so we write raw EBML Tags + AttachedFile
    elements appended at the end of the file.  Most players (VLC, MPC,
    browsers) will scan and pick up these tags.
    """
    import struct

    # EBML variable-length integer encoding for sizes only
    def _ebml_vint(value):
        """Encode an unsigned integer as EBML VINT (used for element sizes)."""
        if value <= 0x7F:
            return struct.pack(">B", 0x80 | value)
        needed = max(1, (value.bit_length() + 6) // 7)
        buf = bytearray(needed)
        buf[0] = (1 << (8 - needed)) | ((value >> (7 * (needed - 1))) & ((1 << (8 - needed)) - 1))
        for i in range(1, needed):
            buf[i] = (value >> (7 * (needed - 1 - i))) & 0x7F
        return bytes(buf)

    def _ebml_uint_elem(elem_id: bytes, value: int):
        """Build a proper EBML UInteger element: ID + VINT(size) + raw bytes."""
        # Find minimal byte count for the value
        if value == 0:
            data = b"\x00"
        else:
            byte_len = (value.bit_length() + 7) // 8
            data = value.to_bytes(byte_len, "big")
        return elem_id + _ebml_vint(len(data)) + data

    def _ebml_str_elem(elem_id: bytes, s: str):
        """Build a proper EBML UTF-8 String element."""
        data = s.encode("utf-8")
        return elem_id + _ebml_vint(len(data)) + data

    def _ebml_master(elem_id: bytes, children: bytes):
        """Build an EBML Master element containing child elements."""
        return elem_id + _ebml_vint(len(children)) + children

    # ── Build SimpleTag elements ───────────────────────────────
    simple_tags = b""
    def _add_tag(name, value):
        nonlocal simple_tags
        tn = _ebml_str_elem(b"\x45\xA3", name)      # TagName
        ts = _ebml_str_elem(b"\x44\x87", value)     # TagString
        simple_tags += _ebml_master(b"\x67\xC8", tn + ts)  # SimpleTag

    if title:
        _add_tag("TITLE", title)
    # Always write ARTIST tag — fall back to "Unknown Artist"
    _add_tag("ARTIST", artist or "Unknown Artist")
    if album:
        _add_tag("ALBUM", album)
    if year:
        _add_tag("DATE", str(year))
    if track_number:
        _add_tag("TRACK_NUMBER", str(track_number))

    if not simple_tags:
        return

    # ── Build Targets (TargetTypeValue = 50 = track level) ──
    ttv = _ebml_uint_elem(b"\x68\xCA", 50)         # TargetTypeValue
    targets = _ebml_master(b"\x63\xC0", ttv)        # Targets

    # ── Build Tag element ─────────────────────────────────────
    tag = _ebml_master(b"\x73\x73", targets + simple_tags)

    # ── Build Tags element ────────────────────────────────────
    tags_element = _ebml_master(b"\x12\x54\xC3\x67", tag)

    # ── Add cover art as AttachedFile if provided ─────────────
    attached_file = b""
    if cover_data:
        mime = _guess_mime(cover_data)
        file_name = "cover.jpg" if "jpeg" in mime else "cover.png"
        attached = (
            _ebml_str_elem(b"\x46\x6E", file_name)     # FileName
            + _ebml_str_elem(b"\x46\x60", mime)        # FileMimeType
            + _ebml_master(b"\x46\x5C", cover_data)    # FileData (binary)
            + _ebml_uint_elem(b"\x46\x7E", 6)          # FileUsedInPlayback
        )
        attached_file = _ebml_master(b"\x61\xA7", attached)

    # ── Write everything in a single append ───────────────────
    with open(filepath, "ab") as f:
        f.write(tags_element + attached_file)

    logger.info(f"WebM EBML tags written: {os.path.basename(filepath)} — {artist} - {title}")


# ═══════════════════════════════════════════════════════════════════════
# File helper
# ═══════════════════════════════════════════════════════════════════════

def _find_audio_in_dir(directory: str) -> Optional[str]:
    """Find the first audio file in a directory. Returns absolute path or None."""
    audio_exts = {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus", ".aac", ".webm"}
    try:
        for fn in os.listdir(directory):
            if fn == ".gitkeep":
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext in audio_exts:
                return os.path.join(directory, fn)
    except Exception:
        pass
    return None


def _move_to_downloads(src_path: str) -> Optional[str]:
    """Move file from src_path to DOWNLOAD_DIR. Returns relative path or None."""
    fn = os.path.basename(src_path)
    dest = os.path.join(settings.DOWNLOAD_DIR, fn)
    if os.path.exists(dest):
        # Remove stale file rather than adding random hex suffix
        try:
            os.remove(dest)
        except OSError:
            pass
    try:
        shutil.move(src_path, dest)
        return os.path.relpath(dest, settings.DOWNLOAD_DIR)
    except Exception as e:
        logger.error(f"Failed to move file to downloads: {e}")
        return None


def _cleanup_dir(d: str) -> None:
    try:
        if os.path.exists(d):
            shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


async def _process_metadata_for_file(
    filepath: str, url: str,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
    metadata: Optional[dict] = None,
    artist_hint: Optional[str] = None,
    title_hint: Optional[str] = None,
) -> str:
    """Fetch metadata, inject tags, rename file. Returns relative filename.

    If *metadata* is provided (pre-enriched by the caller), skips the internal
    ``fetch_metadata()`` call.  *artist_hint* / *title_hint* fill in missing
    artist/title after the fetch — used when SpotAPI returns empty artist but
    the frontend already has it from search results.
    """
    rel = os.path.relpath(filepath, settings.DOWNLOAD_DIR)

    if metadata is None:
        if on_progress:
            await on_progress("processing", "Fetching track metadata...")
        metadata = await fetch_metadata(url)

    # Enrich with frontend-provided artist/title when SpotAPI returned empty.
    # Build a minimal dict from hints even if SpotAPI failed entirely.
    if artist_hint or title_hint:
        if metadata is None:
            metadata = {}
        if artist_hint and not metadata.get("artist"):
            metadata["artist"] = artist_hint
        if title_hint and not metadata.get("title"):
            metadata["title"] = title_hint

    if metadata and metadata.get("title"):
        if on_progress:
            await on_progress("processing", "Downloading cover art...")
        cover_data = None
        if metadata.get("cover_url"):
            cover_data = await _download_cover_art(metadata["cover_url"])

        if on_progress:
            await on_progress("processing", "Embedding metadata tags...")
        inject_metadata(filepath, metadata, cover_data)

        # Rename to clean format
        ext = os.path.splitext(filepath)[1].lower()
        safe_name = sanitize_filename(metadata.get("artist", ""), metadata.get("title", ""))
        new_name = f"{safe_name}{ext}"
        new_path = os.path.join(settings.DOWNLOAD_DIR, new_name)
        if os.path.exists(new_path) and os.path.abspath(new_path) != os.path.abspath(filepath):
            # Remove stale file so rename succeeds without random hex
            try:
                os.remove(new_path)
                logger.info(f"Removed stale file: {new_path}")
            except OSError:
                pass
        try:
            os.rename(filepath, new_path)
            logger.info(f"Renamed: {os.path.basename(filepath)} -> {new_name}")
            return os.path.relpath(new_path, settings.DOWNLOAD_DIR)
        except OSError as e:
            logger.warning(f"Failed to rename file: {e}")
            # If rename failed because dest exists (race), add a timestamp suffix
            if os.path.exists(new_path):
                try:
                    base, e = os.path.splitext(new_name)
                    new_name = f"{base}_{int(time.time())}{e}"
                    new_path2 = os.path.join(settings.DOWNLOAD_DIR, new_name)
                    os.rename(filepath, new_path2)
                    logger.info(f"Renamed (timestamp): {os.path.basename(filepath)} -> {new_name}")
                    return os.path.relpath(new_path2, settings.DOWNLOAD_DIR)
                except OSError:
                    pass
    else:
        logger.warning(f"No metadata found for {url} — file will not be tagged")

    return rel


# ═══════════════════════════════════════════════════════════════════════
# Engine 1: SpotiFLAC (subprocess via thread executor)
# ═══════════════════════════════════════════════════════════════════════

def _find_spotiflac_binary() -> Optional[str]:
    """Find the spotiflac executable, searching PATH and pip scripts dirs."""
    for name in ("spotiflac", "spotiflac.exe"):
        path = shutil.which(name)
        if path:
            return path
    # Check Python Scripts directory (pip install location on Windows)
    scripts_dir = os.path.join(os.path.dirname(sys.executable), "Scripts")
    for name in ("spotiflac", "spotiflac.exe"):
        full = os.path.join(scripts_dir, name)
        if os.path.isfile(full):
            return full
    # Check user-site scripts directory
    try:
        import site
        user_scripts = os.path.join(site.getusersitepackages().replace("site-packages", "Scripts"))
        for name in ("spotiflac", "spotiflac.exe"):
            full = os.path.join(user_scripts, name)
            if os.path.isfile(full):
                return full
    except Exception:
        pass
    return None


def _build_spotiflac_cmd(req: DownloadRequest, temp_dir: str) -> list[str]:
    """Build the SpotiFLAC command."""
    binary = _find_spotiflac_binary()
    if binary:
        cmd = [binary]
    else:
        cmd = [sys.executable, "-m", "spotiflac"]
    cmd.extend([str(req.url), temp_dir])
    if req.services:
        cmd.extend(["--service", *req.services])
    if req.quality:
        cmd.extend(["--quality", req.quality])
    return cmd


async def download_spotiflac(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """Download via SpotiFLAC subprocess (runs in thread executor to avoid
    Windows asyncio event-loop incompatibility).
    """
    if not is_spotiflac_available():
        msg = "SpotiFLAC not available. Install with: pip install spotiflac"
        logger.error(msg)
        if on_progress:
            await on_progress("failed", msg)
        return None

    temp_dir = tempfile.mkdtemp(prefix="spotiflac_", dir=settings.DOWNLOAD_DIR)
    cmd_args = _build_spotiflac_cmd(req, temp_dir)
    timeout = req.timeout_s if req.timeout_s and req.timeout_s >= 30 else 600

    try:
        if on_progress:
            await on_progress("downloading", "Starting SpotiFLAC download...")

        def _run():
            proc = subprocess.Popen(
                cmd_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                stdout, stderr = proc.communicate(timeout=float(timeout))
                return proc.returncode, stdout, stderr
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                return None, None, None

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run)

        if result[0] is None:
            # Timeout
            logger.error(f"SpotiFLAC timed out after {timeout}s for {req.url}")
            if on_progress:
                await on_progress("failed", f"Download timed out after {timeout}s")
            _cleanup_dir(temp_dir)
            return None

        returncode, stdout, stderr = result

        if returncode != 0:
            err_msg = (stderr.decode(errors="replace") or stdout.decode(errors="replace")).strip()[:200] or "Unknown error"
            logger.error(f"SpotiFLAC failed (exit {returncode}) for {req.url}: {err_msg}")
            if on_progress:
                await on_progress("failed", err_msg)
            _cleanup_dir(temp_dir)
            return None

        if on_progress:
            await on_progress("processing", "Processing downloaded file...")

        audio_path = _find_audio_in_dir(temp_dir)
        if not audio_path:
            if on_progress:
                await on_progress("failed", "Download completed but no audio file found")
            logger.error(f"No audio file found after SpotiFLAC for {req.url}")
            _cleanup_dir(temp_dir)
            return None

        rel_path = _move_to_downloads(audio_path)
        if not rel_path:
            if on_progress:
                await on_progress("failed", "Failed to move downloaded file")
            _cleanup_dir(temp_dir)
            return None

        abs_path = os.path.join(settings.DOWNLOAD_DIR, rel_path)
        final_filename = await _process_metadata_for_file(
            abs_path, str(req.url), on_progress,
            artist_hint=req.artist, title_hint=req.title,
        )

        if on_progress:
            await on_progress("complete", final_filename)
        logger.info(f"SpotiFLAC download complete: {req.url} -> {final_filename}")
        return final_filename

    except Exception as e:
        logger.error(f"SpotiFLAC download error: {type(e).__name__}: {e}")
        if on_progress:
            await on_progress("failed", f"{type(e).__name__}: {e}")
        _cleanup_dir(temp_dir)
        return None


# ═══════════════════════════════════════════════════════════════════════
# Engine 2: yt-dlp (searches YouTube, downloads best audio)
# ═══════════════════════════════════════════════════════════════════════

async def download_ytdlp(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """Download via yt-dlp. Uses SpotAPI metadata to build a YouTube search query.

    Strategy:
    1. Extract track ID from Spotify URL
    2. Fetch metadata from SpotAPI to get "Artist - Title"
    3. Search YouTube with "Artist - Title" via yt-dlp
    4. Download best audio to DOWNLOAD_DIR
    5. Inject metadata tags
    """
    if not is_ytdlp_available():
        msg = "yt-dlp not found. Install with: pip install yt-dlp"
        logger.error(msg)
        if on_progress:
            await on_progress("failed", msg)
        return None

    if on_progress:
        await on_progress("pending", "Fetching track info...")

    # Build search query — prefer frontend-provided artist/title (SpotAPI search
    # results DO return artists, even when get_track_info doesn't)
    metadata = await fetch_metadata(str(req.url))
    search_query = str(req.url)

    frontend_artist = req.artist
    frontend_title = req.title
    if frontend_artist and frontend_title:
        search_query = f"{frontend_artist} - {frontend_title}"
        logger.info(f"yt-dlp search query (from frontend): {search_query}")
    elif metadata and metadata.get("title"):
        if metadata.get("artist"):
            search_query = f"{metadata['artist']} - {metadata['title']}"
        else:
            search_query = metadata["title"]
        logger.info(f"yt-dlp search query: {search_query}")

    # Enrich metadata with frontend-provided artist/title so they reach the tag injector.
    # SpotAPI's get_track_info may return empty artist for some tracks, but the
    # frontend search results DO have the correct artist.
    if frontend_artist or frontend_title:
        if metadata is None:
            metadata = {}
        if frontend_artist and not metadata.get("artist"):
            metadata["artist"] = frontend_artist
        if frontend_title and not metadata.get("title"):
            metadata["title"] = frontend_title

    if on_progress:
        await on_progress("downloading", f"Searching YouTube: {search_query[:60]}...")

    # Map quality to yt-dlp format
    quality_map = {
        "LOSSLESS": "bestaudio/best",
        "HIGH": "bestaudio[abr<=320]/bestaudio/best",
        "MEDIUM": "bestaudio[abr<=160]/bestaudio/best",
    }
    fmt = quality_map.get(req.quality, "bestaudio/best")

    # Output template: save to downloads dir with temp name
    out_tmpl = os.path.join(settings.DOWNLOAD_DIR, "%(title)s.%(ext)s")



    # Always convert to MP3 via FFmpegExtractAudio — universal ID3 tag support
    ydl_opts = {
        "format": fmt,
        "outtmpl": out_tmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
        }],
    }

    try:
        # Capture metadata for title matching inside the executor
        _spotify_title = metadata.get("title", "") if metadata else ""

        def _run_ytdlp():
            # Step 1: search YouTube for top 5 results (don't download yet)
            search_opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
            with yt_dlp.YoutubeDL(search_opts) as ydl:
                info = ydl.extract_info(f"ytsearch5:{search_query}", download=False)

            if not info or "entries" not in info or not info["entries"]:
                return None

            entries = info["entries"]

            # Step 2: pick the best match by title similarity
            best = _pick_best_match(entries, _spotify_title)
            if not best:
                return None

            logger.info(f"Best match: {best.get('title', '?')} (id={best.get('id', '?')})")

            # Step 3: download ONLY the best match
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([best["webpage_url"]])

            # Step 4: find the downloaded file
            yt_title = best.get("title", "unknown")
            for fn in os.listdir(settings.DOWNLOAD_DIR):
                full = os.path.join(settings.DOWNLOAD_DIR, fn)
                if os.path.isfile(full) and os.path.getmtime(full) > time.time() - 120:
                    if fn.startswith(yt_title[:30]) or yt_title[:30] in fn:
                        ext_lower = os.path.splitext(fn)[1].lower()
                        if ext_lower in {".mp3", ".webm", ".m4a", ".opus", ".ogg", ".flac", ".wav"}:  # .mp3 first (FFmpegExtractAudio default)
                            return os.path.relpath(full, settings.DOWNLOAD_DIR)
            return _find_newest_audio()

        loop = asyncio.get_running_loop()
        rel_path = await loop.run_in_executor(None, _run_ytdlp)

        if not rel_path:
            if on_progress:
                await on_progress("failed", "yt-dlp download produced no file")
            return None

        abs_path = os.path.join(settings.DOWNLOAD_DIR, rel_path)

        # Inject metadata — pass enriched metadata so the frontend artist reaches the tag injector
        final_filename = await _process_metadata_for_file(abs_path, str(req.url), on_progress, metadata=metadata)

        if on_progress:
            await on_progress("complete", final_filename)
        logger.info(f"yt-dlp download complete: {req.url} -> {final_filename}")
        return final_filename

    except Exception as e:
        logger.error(f"yt-dlp download error: {type(e).__name__}: {e}")
        if on_progress:
            await on_progress("failed", f"yt-dlp: {type(e).__name__}: {e}")
        return None




def _title_similarity(a: str, b: str) -> float:
    """Score 0.0-1.0 how similar two titles are, ignoring case/symbols."""
    a_clean = re.sub(r"[^a-z0-9\s]", "", a.lower())
    b_clean = re.sub(r"[^a-z0-9\s]", "", b.lower())
    return difflib.SequenceMatcher(None, a_clean.strip(), b_clean.strip()).ratio()


def _pick_best_match(entries: list, target_title: str) -> Optional[dict]:
    """From a list of yt-dlp search entries, pick the one whose title
    is most similar to target_title.  Returns the best entry or None."""
    if not entries:
        return None
    if not target_title:
        return entries[0]

    best_entry = None
    best_score = 0.0
    for entry in entries:
        entry_title = entry.get("title", "")
        score = _title_similarity(target_title, entry_title)
        if score > best_score:
            best_score = score
            best_entry = entry

    # Require at least 30% similarity; otherwise fall back to first result
    if best_score < 0.3:
        logger.warning(
            f"Low title match (best={best_score:.2f}), using first result: "
            f"{entries[0].get('title', '?')}"
        )
        return entries[0]

    logger.info(f"Title match: score={best_score:.2f} for '{best_entry.get('title', '?')}'")
    return best_entry


def _find_newest_audio() -> Optional[str]:
    """Find the most recently modified audio file in DOWNLOAD_DIR."""
    audio_exts = {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus", ".aac", ".webm"}
    best = None
    best_time = 0
    try:
        for fn in os.listdir(settings.DOWNLOAD_DIR):
            if fn == ".gitkeep":
                continue
            if os.path.splitext(fn)[1].lower() not in audio_exts:
                continue
            full = os.path.join(settings.DOWNLOAD_DIR, fn)
            mtime = os.path.getmtime(full)
            if mtime > best_time:
                best_time = mtime
                best = os.path.relpath(full, settings.DOWNLOAD_DIR)
    except Exception:
        pass
    return best


# ═══════════════════════════════════════════════════════════════════════
# Engine 3: SpotDL (subprocess via thread executor)
# ═══════════════════════════════════════════════════════════════════════

def _build_spotdl_cmd(req: DownloadRequest, temp_dir: str) -> list[str]:
    """Build the SpotDL command. Tries binary first, then python -m."""
    binary = _find_binary("spotdl", "spotdl.exe")
    if binary:
        cmd = [binary]
    else:
        cmd = [sys.executable, "-m", "spotdl"]
    cmd.extend(["download", str(req.url), "--output", temp_dir])
    if req.quality == "LOSSLESS":
        cmd.extend(["--format", "flac"])
    elif req.quality == "HIGH":
        cmd.extend(["--bitrate", "320k"])
    else:
        cmd.extend(["--bitrate", "160k"])
    return cmd


async def download_spotdl(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """Download via SpotDL CLI (runs in thread executor).

    Injects a monkey-patch via PYTHONSTARTUP to fix the SpotipyFree
    ``KeyError: 'uri'`` bug before SpotDL runs.
    """
    if not is_spotdl_available():
        msg = "SpotDL not available. Install with: pip install spotdl"
        logger.error(msg)
        if on_progress:
            await on_progress("failed", msg)
        return None

    if on_progress:
        await on_progress("downloading", "Starting SpotDL download...")

    temp_dir = tempfile.mkdtemp(prefix="spotdl_", dir=settings.DOWNLOAD_DIR)
    cmd_args = _build_spotdl_cmd(req, temp_dir)
    timeout = req.timeout_s if req.timeout_s and req.timeout_s >= 30 else 600

    # Write a sitecustomize.py to monkey-patch SpotipyFree before SpotDL loads.
    # Python's site module imports sitecustomize.py before any user code, so
    # the patch applies before spotdl touches SpotipyFree.
    sitecustomize_path = os.path.join(temp_dir, "sitecustomize.py")
    with open(sitecustomize_path, "w") as f:
        f.write("""
from SpotipyFree.Formatter import SpotifyFormatter
_spotdl_original_fmt = SpotifyFormatter.formatTrack

@staticmethod
def _spotdl_patched_formatTrack(track, formattedArtists, songId=None, album=[]):
    if songId is None:
        uri = track.get("uri", "")
        if uri:
            songId = uri.removeprefix("spotify:track:")
        else:
            songId = track.get("id", "")
    return _spotdl_original_fmt(track, formattedArtists, songId=songId, album=album)

SpotifyFormatter.formatTrack = _spotdl_patched_formatTrack
""")

    sub_env = os.environ.copy()
    # Prepend temp_dir to sys.path so sitecustomize.py is found
    pp = sub_env.get("PYTHONPATH", "")
    sub_env["PYTHONPATH"] = temp_dir + (os.pathsep + pp if pp else "")

    try:
        def _run():
            proc = subprocess.Popen(
                cmd_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=sub_env,
            )
            try:
                stdout, stderr = proc.communicate(timeout=float(timeout))
                return proc.returncode, stdout, stderr
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                return None, None, None

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run)

        if result[0] is None:
            logger.error(f"SpotDL timed out after {timeout}s for {req.url}")
            if on_progress:
                await on_progress("failed", f"SpotDL timed out after {timeout}s")
            _cleanup_dir(temp_dir)
            return None

        returncode, stdout, stderr = result

        if returncode != 0:
            err_msg = (stderr.decode(errors="replace") or stdout.decode(errors="replace")).strip()[:200] or "Unknown error"
            logger.error(f"SpotDL failed (exit {returncode}) for {req.url}: {err_msg}")
            if on_progress:
                await on_progress("failed", err_msg)
            _cleanup_dir(temp_dir)
            return None

        if on_progress:
            await on_progress("processing", "Processing SpotDL download...")

        audio_path = _find_audio_in_dir(temp_dir)
        if not audio_path:
            for root, _, files in os.walk(temp_dir):
                for fn in files:
                    ext = os.path.splitext(fn)[1].lower()
                    if ext in {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus"}:
                        audio_path = os.path.join(root, fn)
                        break
                if audio_path:
                    break

        if not audio_path:
            if on_progress:
                await on_progress("failed", "SpotDL completed but no audio file found")
            _cleanup_dir(temp_dir)
            return None

        rel_path = _move_to_downloads(audio_path)
        _cleanup_dir(temp_dir)
        if not rel_path:
            if on_progress:
                await on_progress("failed", "Failed to move SpotDL file")
            return None

        abs_path = os.path.join(settings.DOWNLOAD_DIR, rel_path)
        final_filename = await _process_metadata_for_file(
            abs_path, str(req.url), on_progress,
            artist_hint=req.artist, title_hint=req.title,
        )

        if on_progress:
            await on_progress("complete", final_filename)
        logger.info(f"SpotDL download complete: {req.url} -> {final_filename}")
        return final_filename

    except Exception as e:
        logger.error(f"SpotDL download error: {type(e).__name__}: {e}")
        if on_progress:
            await on_progress("failed", f"SpotDL: {type(e).__name__}: {e}")
        _cleanup_dir(temp_dir)
        return None


# ═══════════════════════════════════════════════════════════════════════
# Dispatcher — routes to the selected downloader
# ═══════════════════════════════════════════════════════════════════════

async def run_download(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """Run the download using the configured default downloader.

    Uses req.downloader if set, otherwise settings.DEFAULT_DOWNLOADER.
    Falls back to the first available downloader if the configured one
    is not installed.
    """
    preferred = req.downloader or settings.DEFAULT_DOWNLOADER
    available = get_available_downloaders()

    logger.info(f"Download dispatcher: preferred={preferred}, available={available}")

    if preferred in available:
        engine = preferred
    elif available:
        engine = available[0]
        logger.warning(f"Preferred downloader '{preferred}' not available, using '{engine}'")
    else:
        msg = "No downloader available. Install spotiflac, yt-dlp, or spotdl."
        logger.error(msg)
        if on_progress:
            await on_progress("failed", msg)
        return None

    logger.info(f"Using downloader: {engine}")

    if engine == "spotiflac":
        return await download_spotiflac(req, on_progress)
    elif engine == "ytdlp":
        return await download_ytdlp(req, on_progress)
    elif engine == "spotdl":
        return await download_spotdl(req, on_progress)
    else:
        if on_progress:
            await on_progress("failed", f"Unknown downloader: {engine}")
        return None


# ── Log downloaded files ─────────────────────────────────────────────

def log_downloaded_files():
    """Log what's in the download directory."""
    try:
        files = os.listdir(settings.DOWNLOAD_DIR)
        audio_files = [
            f for f in files
            if f.endswith((".mp3", ".flac", ".m4a", ".wav", ".ogg", ".opus"))
            and f != ".gitkeep"
        ]
        if audio_files:
            logger.info(
                f"Download directory has {len(audio_files)} audio files: "
                f"{', '.join(audio_files[:5])}"
                + (f" and {len(audio_files) - 5} more..." if len(audio_files) > 5 else "")
            )
    except Exception:
        pass
