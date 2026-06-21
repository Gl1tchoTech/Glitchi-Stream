"""yt-dlp Audio Streamer — streams songs directly without downloading.

This module uses yt-dlp's extract_info (download=False) to resolve a YouTube
audio URL from a search query, then proxies the audio chunks to the client
via httpx streaming.  Zero bytes are written to disk.

Key guarantees:
• No files saved to disk — pure in-memory streaming
• No API keys or client secrets required
• Results cached for fast repeat playback (YouTube URLs expire after ~6h)
• Runs yt-dlp extraction in a thread pool to keep the event loop free
"""

import asyncio
import time
from typing import Optional, AsyncGenerator

import httpx
import yt_dlp

from app.utils.logger import logger

# ── Cache ────────────────────────────────────────────────────────────
# YouTube signed URLs last ~6 hours; we evict at 5 hours.
_stream_cache: dict[str, dict] = {}
_CACHE_TTL = 5 * 3600
_MAX_CACHE_SIZE = 200


def _get_ydl_opts() -> dict:
    """Return yt-dlp options optimised for audio-only extraction."""
    return {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }


# ── Resolve ──────────────────────────────────────────────────────────

async def resolve_stream(query: str) -> Optional[dict]:
    """Search YouTube for *query* and return audio-stream metadata.

    Returns a dict with:
        • ``url``         – direct audio stream URL (signed, short-lived)
        • ``title``        – YouTube video title
        • ``duration``     – duration in seconds
        • ``thumbnail``    – thumbnail image URL
        • ``webpage_url``  – YouTube watch page

    The returned URL is **not** suitable for direct client use because
    YouTube signs it for a single IP.  Call :func:`stream_audio_chunks`
    to proxy the audio through the server.
    """
    cache_key = query.lower().strip()

    # ── cache hit ────────────────────────────────────────────────
    if cache_key in _stream_cache:
        entry = _stream_cache[cache_key]
        age = time.time() - entry.get("_cached_at", 0)
        if age < _CACHE_TTL:
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
            "url":          entry.get("url", ""),
            "title":        entry.get("title", ""),
            "duration":     entry.get("duration", 0),
            "thumbnail":    entry.get("thumbnail", ""),
            "webpage_url":  entry.get("webpage_url", ""),
        }

        if not result["url"]:
            logger.warning(f"No audio URL found for: {query}")
            return None

        # ── cache ───────────────────────────────────────────────
        result["_cached_at"] = time.time()
        if len(_stream_cache) >= _MAX_CACHE_SIZE:
            # evict oldest 25 %
            sorted_keys = sorted(
                _stream_cache, key=lambda k: _stream_cache[k].get("_cached_at", 0),
            )
            for old_key in sorted_keys[: len(sorted_keys) // 4]:
                del _stream_cache[old_key]
        _stream_cache[cache_key] = result

        logger.info(
            f"yt-dlp resolved: '{result['title']}' ({result['duration']}s)"
        )
        return {k: v for k, v in result.items() if not k.startswith("_")}

    except Exception as e:
        logger.error(f"yt-dlp resolve error for '{query}': {type(e).__name__}: {e}")
        return None


# ── Stream proxy ─────────────────────────────────────────────────────

async def stream_audio_chunks(audio_url: str, query: str) -> AsyncGenerator[bytes, None]:
    """Proxy a YouTube audio URL to the client as an async byte generator.

    Yields 64 KiB chunks.  Handles redirects gracefully and logs errors.
    Call from a FastAPI ``StreamingResponse``.
    """
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            async with client.stream("GET", audio_url, follow_redirects=True) as resp:
                if resp.status_code >= 400:
                    logger.error(
                        f"YouTube stream error: HTTP {resp.status_code} for {query}"
                    )
                    return
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    yield chunk
    except httpx.ReadTimeout:
        logger.warning(f"Stream timeout for: {query}")
    except Exception as e:
        logger.error(f"Stream proxy error for '{query}': {type(e).__name__}: {e}")


# ── Content-type helper ──────────────────────────────────────────────

def guess_content_type(audio_url: str) -> str:
    """Return a MIME type based on the URL extension."""
    lower = audio_url.lower()
    if ".mp3" in lower:
        return "audio/mpeg"
    if ".webm" in lower:
        return "audio/webm"
    if ".ogg" in lower or ".opus" in lower:
        return "audio/ogg"
    return "audio/mp4"


# ── Cache management ─────────────────────────────────────────────────

def clear_cache() -> None:
    """Clear the streaming URL cache."""
    _stream_cache.clear()
    logger.info("yt-dlp stream cache cleared")
