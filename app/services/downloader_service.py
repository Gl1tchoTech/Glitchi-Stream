"""
Unified Downloader Service — dispatches to the configured downloader.

Three engines:
  - ``spotiflac`` — SpotiFLAC subprocess (lossless from Qobuz/Tidal)
  - ``ytdlp``    — yt-dlp searches YouTube, downloads best audio
  - ``spotdl``   — SpotDL CLI subprocess (Spotify → YouTube → tagged audio)

All engines share the same metadata-injection pipeline (SpotAPI → mutagen).
"""

import asyncio
import os
import re
import shutil
import tempfile
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

def _find_binary(*names: str) -> Optional[str]:
    """Find the first available binary on PATH."""
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


def is_spotiflac_available() -> bool:
    return _find_binary("spotiflac", "spotiflac.exe") is not None


def is_ytdlp_available() -> bool:
    return _find_binary("yt-dlp", "yt-dlp.exe") is not None


def is_spotdl_available() -> bool:
    return _find_binary("spotdl", "spotdl.exe") is not None


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

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _fetch)
    except Exception as e:
        logger.error(f"SpotAPI metadata fetch error for {track_id}: {type(e).__name__}: {e}")
        return None


async def _fetch_metadata_fallback(url: str) -> Optional[dict]:
    """Fallback: extract track ID and try query_songs with it.

    Used when direct track_id metadata fetch fails.
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

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _search)
    except Exception as e:
        logger.error(f"Fallback metadata search error: {type(e).__name__}: {e}")
        return None


async def fetch_metadata(url: str) -> Optional[dict]:
    """Fetch metadata for a Spotify URL, with fallback."""
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
    if artist:
        audio["TPE1"] = TPE1(encoding=3, text=artist)
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
    if artist:
        audio["artist"] = artist
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
    if artist:
        audio["\xa9ART"] = artist
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
    if artist:
        audio["artist"] = artist
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
        base, ext = os.path.splitext(fn)
        dest = os.path.join(settings.DOWNLOAD_DIR, f"{base}_{os.urandom(4).hex()}{ext}")
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
) -> str:
    """Fetch metadata, inject tags, rename file. Returns relative filename."""
    rel = os.path.relpath(filepath, settings.DOWNLOAD_DIR)

    if on_progress:
        await on_progress("processing", "Fetching track metadata...")

    metadata = await fetch_metadata(url)

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
            base, e = os.path.splitext(new_name)
            new_name = f"{base}_{os.urandom(3).hex()}{e}"
            new_path = os.path.join(settings.DOWNLOAD_DIR, new_name)
        try:
            os.rename(filepath, new_path)
            logger.info(f"Renamed: {os.path.basename(filepath)} -> {new_name}")
            return os.path.relpath(new_path, settings.DOWNLOAD_DIR)
        except OSError as e:
            logger.warning(f"Failed to rename file: {e}")
    else:
        logger.warning(f"No metadata found for {url} — file will not be tagged")

    return rel


# ═══════════════════════════════════════════════════════════════════════
# Engine 1: SpotiFLAC (subprocess)
# ═══════════════════════════════════════════════════════════════════════

async def download_spotiflac(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """Download via SpotiFLAC subprocess. Returns relative filename or None."""
    spotiflac_bin = _find_binary("spotiflac", "spotiflac.exe")
    if not spotiflac_bin:
        msg = "SpotiFLAC binary not found. Install with: pip install spotiflac"
        logger.error(msg)
        if on_progress:
            await on_progress("failed", msg)
        return None

    temp_dir = tempfile.mkdtemp(prefix="spotiflac_", dir=settings.DOWNLOAD_DIR)
    cmd_args = [spotiflac_bin, str(req.url), temp_dir]
    if req.services:
        cmd_args.extend(["--service", *req.services])
    if req.quality:
        cmd_args.extend(["--quality", req.quality])

    timeout = req.timeout_s if req.timeout_s and req.timeout_s >= 30 else 600

    try:
        if on_progress:
            await on_progress("downloading", "Starting SpotiFLAC download...")

        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        if on_progress:
            await on_progress("downloading", "Downloading from Spotify (SpotiFLAC)...")

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=float(timeout))
        except asyncio.TimeoutError:
            logger.error(f"SpotiFLAC timed out after {timeout}s for {req.url}")
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=10)
            except Exception:
                pass
            if on_progress:
                await on_progress("failed", f"Download timed out after {timeout}s")
            _cleanup_dir(temp_dir)
            return None

        if proc.returncode != 0:
            err_msg = stderr.decode().strip()[:200] or "Unknown error"
            logger.error(f"SpotiFLAC failed (exit {proc.returncode}) for {req.url}: {err_msg}")
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
        final_filename = await _process_metadata_for_file(abs_path, str(req.url), on_progress)

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

    # Get metadata first so we can build a good search query
    metadata = await fetch_metadata(str(req.url))
    search_query = str(req.url)
    if metadata and metadata.get("artist") and metadata.get("title"):
        search_query = f"{metadata['artist']} - {metadata['title']}"
        logger.info(f"yt-dlp search query: {search_query}")

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



    ydl_opts = {
        "format": fmt,
        "outtmpl": out_tmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3" if req.quality != "LOSSLESS" else "best",
        }],
    }

    try:
        def _run_ytdlp():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(f"ytsearch:{search_query}", download=True)
                if info and "entries" in info and info["entries"]:
                    entry = info["entries"][0]
                    # yt-dlp may add extension to the output template
                    title = entry.get("title", "unknown")
                    ext = entry.get("ext", "webm")
                    # Find the downloaded file
                    for fn in os.listdir(settings.DOWNLOAD_DIR):
                        full = os.path.join(settings.DOWNLOAD_DIR, fn)
                        if os.path.isfile(full) and os.path.getmtime(full) > time.time() - 60:
                            if fn.startswith(title[:30]) or title[:30] in fn:
                                ext_lower = os.path.splitext(fn)[1].lower()
                                if ext_lower in {".mp3", ".webm", ".m4a", ".opus", ".ogg", ".flac", ".wav"}:
                                    return os.path.relpath(full, settings.DOWNLOAD_DIR)
                    # Fallback: return newest audio file
                    return _find_newest_audio()
                return None

        loop = asyncio.get_event_loop()
        rel_path = await loop.run_in_executor(None, _run_ytdlp)

        if not rel_path:
            if on_progress:
                await on_progress("failed", "yt-dlp download produced no file")
            return None

        abs_path = os.path.join(settings.DOWNLOAD_DIR, rel_path)

        # Inject metadata
        final_filename = await _process_metadata_for_file(abs_path, str(req.url), on_progress)

        if on_progress:
            await on_progress("complete", final_filename)
        logger.info(f"yt-dlp download complete: {req.url} -> {final_filename}")
        return final_filename

    except Exception as e:
        logger.error(f"yt-dlp download error: {type(e).__name__}: {e}")
        if on_progress:
            await on_progress("failed", f"yt-dlp: {type(e).__name__}: {e}")
        return None




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
# Engine 3: SpotDL (subprocess)
# ═══════════════════════════════════════════════════════════════════════

async def download_spotdl(
    req: DownloadRequest,
    on_progress: Optional[Callable[[str, str], Awaitable[None]]] = None,
) -> Optional[str]:
    """Download via SpotDL CLI subprocess."""
    spotdl_bin = _find_binary("spotdl", "spotdl.exe")
    if not spotdl_bin:
        msg = "SpotDL not found. Install with: pip install spotdl"
        logger.error(msg)
        if on_progress:
            await on_progress("failed", msg)
        return None

    if on_progress:
        await on_progress("downloading", "Starting SpotDL download...")

    # SpotDL handles its own metadata, so use a temp output dir
    temp_dir = tempfile.mkdtemp(prefix="spotdl_", dir=settings.DOWNLOAD_DIR)

    cmd_args = [
        spotdl_bin, "download", str(req.url),
        "--output", temp_dir,
    ]

    # Map quality
    if req.quality == "LOSSLESS":
        cmd_args.extend(["--format", "flac"])
    elif req.quality == "HIGH":
        cmd_args.extend(["--bitrate", "320k"])
    else:
        cmd_args.extend(["--bitrate", "160k"])

    timeout = req.timeout_s if req.timeout_s and req.timeout_s >= 30 else 600

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=float(timeout))
        except asyncio.TimeoutError:
            logger.error(f"SpotDL timed out after {timeout}s for {req.url}")
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=10)
            except Exception:
                pass
            if on_progress:
                await on_progress("failed", f"SpotDL timed out after {timeout}s")
            _cleanup_dir(temp_dir)
            return None

        if proc.returncode != 0:
            err_msg = (stderr.decode() or stdout.decode()).strip()[:200] or "Unknown error"
            logger.error(f"SpotDL failed (exit {proc.returncode}) for {req.url}: {err_msg}")
            if on_progress:
                await on_progress("failed", err_msg)
            _cleanup_dir(temp_dir)
            return None

        if on_progress:
            await on_progress("processing", "Processing SpotDL download...")

        audio_path = _find_audio_in_dir(temp_dir)
        if not audio_path:
            # SpotDL might download to a subdirectory
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

        # SpotDL already tags files, but run our pipeline for consistency
        abs_path = os.path.join(settings.DOWNLOAD_DIR, rel_path)
        final_filename = await _process_metadata_for_file(abs_path, str(req.url), on_progress)

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
