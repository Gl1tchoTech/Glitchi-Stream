"""yt-dlp Audio Streamer — streams songs directly, zero disk I/O.

Uses ``anyio.open_process`` (instead of ``asyncio.create_subprocess_exec``)
to avoid Windows event-loop incompatibility with uvicorn's SelectorEventLoop.
yt-dlp handles format selection and ensures the ``moov`` atom is at the start
so the browser can play *immediately*.  Nothing is written to disk.
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
# Primary strategy — yt-dlp subprocess → stdout → browser (via anyio)
# ═══════════════════════════════════════════════════════════════════════

async def stream_audio_chunks(query: str, info: Optional[dict] = None) -> AsyncGenerator[bytes, None]:
    """Resolve a YouTube audio URL via yt-dlp's Python API, then proxy the
    raw audio bytes to the browser via httpx.

    If *info* is provided (pre-resolved by the caller), skips the internal
    resolve step — avoids double resolution when the stream endpoint already
    resolved for media_type detection.

    This avoids subprocess issues on Windows where uvicorn may use a
    ``SelectorEventLoop`` that doesn't support asyncio subprocesses.
    **Zero bytes are written to disk.**
    """
    if info is None:
        info = await resolve_stream(query)
    if not info or not info.get("url"):
        logger.error(f"Could not resolve stream URL for: {query}")
        return

    async for chunk in proxy_audio_chunks(info["url"], query):
        yield chunk


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

        loop = asyncio.get_running_loop()
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
