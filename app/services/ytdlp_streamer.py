"""yt-dlp Audio Streamer — streams songs directly, zero disk I/O.

Uses two strategies:

1. **Subprocess stdout piping** (primary) — runs ``yt-dlp -o -`` to remux
   audio to stdout.  yt-dlp handles format selection and ensures the ``moov``
   atom is at the start so the browser can play *immediately*.  Nothing is
   written to disk.

2. **URL proxy** (fallback) — extracts a signed YouTube URL via
   ``extract_info(download=False)`` and proxies chunks via httpx.  Also zero
   disk I/O, but can suffer from the moov-at-end problem with MP4 audio.
"""

import asyncio
import time
from typing import Optional, AsyncGenerator

import httpx
import yt_dlp

from app.utils.logger import logger

# ── Cache (for URL strategy) ─────────────────────────────────────────
_stream_cache: dict[str, dict] = {}
_CACHE_TTL = 5 * 3600
_MAX_CACHE_SIZE = 200


# ═══════════════════════════════════════════════════════════════════════
# Primary strategy — yt-dlp subprocess → stdout → browser
# ═══════════════════════════════════════════════════════════════════════

async def stream_audio_chunks(query: str) -> AsyncGenerator[bytes, None]:
    """Run yt-dlp as a subprocess, remux audio to stdout, and yield chunks.

    yt-dlp handles format selection AND moves the moov atom to the start
    so the browser can begin playback before the entire file arrives.
    **Zero bytes are written to disk.**
    """
    cmd = [
        "yt-dlp",
        "--format", "bestaudio/best",
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "--output", "-",           # stdout — no file on disk
        "--no-download-archive",
        "--no-cache-dir",
        f"ytsearch:{query}",
    ]

    logger.info(f"yt-dlp stream (subprocess): '{query}'")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Stream stdout in 64 KiB chunks
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk

        # Wait for process to finish (non-blocking since stdout is done)
        await proc.wait()

        if proc.returncode != 0 and proc.returncode is not None:
            stderr = (await proc.stderr.read()).decode(errors="replace")[:200]
            logger.error(f"yt-dlp subprocess failed ({proc.returncode}): {stderr}")

    except FileNotFoundError:
        logger.error("yt-dlp binary not found. Install with: pip install yt-dlp")
    except Exception as e:
        logger.error(f"yt-dlp subprocess stream error: {type(e).__name__}: {e}")


# ═══════════════════════════════════════════════════════════════════════
# Fallback — URL extraction + httpx proxy
# ═══════════════════════════════════════════════════════════════════════

def _get_ydl_opts() -> dict:
    return {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }


async def resolve_stream(query: str) -> Optional[dict]:
    """Search YouTube for *query*, return stream metadata (URL, title, …).

    Uses ``extract_info(download=False)`` — no files written to disk.
    """
    cache_key = query.lower().strip()

    if cache_key in _stream_cache:
        entry = _stream_cache[cache_key]
        if time.time() - entry.get("_cached_at", 0) < _CACHE_TTL:
            logger.info(f"Using cached stream for: {query}")
            return {k: v for k, v in entry.items() if not k.startswith("_")}

    logger.info(f"yt-dlp audio resolve: '{query}'")

    try:
        def _extract():
            with yt_dlp.YoutubeDL(_get_ydl_opts()) as ydl:
                return ydl.extract_info(f"ytsearch:{query}", download=False)

        loop = asyncio.get_event_loop()
        info = await loop.run_in_executor(None, _extract)

        if not info or "entries" not in info or not info["entries"]:
            logger.warning(f"No YouTube results for: {query}")
            return None

        entry = info["entries"][0]
        result = {
            "url":         entry.get("url", ""),
            "title":       entry.get("title", ""),
            "duration":    entry.get("duration", 0),
            "thumbnail":   entry.get("thumbnail", ""),
            "webpage_url": entry.get("webpage_url", ""),
        }

        if not result["url"]:
            logger.warning(f"No audio URL found for: {query}")
            return None

        result["_cached_at"] = time.time()
        if len(_stream_cache) >= _MAX_CACHE_SIZE:
            sorted_keys = sorted(
                _stream_cache, key=lambda k: _stream_cache[k].get("_cached_at", 0),
            )
            for old_key in sorted_keys[: len(sorted_keys) // 4]:
                del _stream_cache[old_key]
        _stream_cache[cache_key] = result

        logger.info(f"yt-dlp resolved: '{result['title']}' ({result['duration']}s)")
        return {k: v for k, v in result.items() if not k.startswith("_")}

    except Exception as e:
        logger.error(f"yt-dlp resolve error for '{query}': {type(e).__name__}: {e}")
        return None


async def proxy_audio_chunks(audio_url: str, query: str) -> AsyncGenerator[bytes, None]:
    """Proxy a YouTube audio URL via httpx (64 KiB chunks, zero disk)."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            async with client.stream("GET", audio_url, follow_redirects=True) as resp:
                if resp.status_code >= 400:
                    logger.error(f"YouTube stream HTTP {resp.status_code} for {query}")
                    return
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    yield chunk
    except httpx.ReadTimeout:
        logger.warning(f"Stream timeout for: {query}")
    except Exception as e:
        logger.error(f"Stream proxy error for '{query}': {type(e).__name__}: {e}")


# ── Helpers ───────────────────────────────────────────────────────────

def guess_content_type(audio_url: str) -> str:
    lower = audio_url.lower()
    if ".mp3" in lower:
        return "audio/mpeg"
    if ".webm" in lower:
        return "audio/webm"
    if ".ogg" in lower or ".opus" in lower:
        return "audio/ogg"
    return "audio/mp4"


def clear_cache() -> None:
    _stream_cache.clear()
    logger.info("yt-dlp stream cache cleared")
