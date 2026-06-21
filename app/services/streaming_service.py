"""YouTube audio streaming service using yt-dlp.

This service searches YouTube for a given track and returns a direct audio
stream URL. No API keys or client secrets are required.

The stream is proxied through our server to avoid IP-restriction issues
with YouTube's signed URLs.
"""

import asyncio
from typing import Optional
import yt_dlp
from app.utils.logger import logger

# Cache for recently resolved streaming URLs (TTL ~5 hours, YouTube URLs last ~6h)
_stream_cache: dict[str, dict] = {}
_CACHE_TTL = 5 * 3600  # 5 hours
_MAX_CACHE_SIZE = 200  # prevent unbounded memory growth


def _get_ydl_opts() -> dict:
    """Return yt-dlp options optimized for audio streaming."""
    return {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }


async def search_youtube_audio(query: str) -> Optional[dict]:
    """Search YouTube for a track and return audio stream info.

    Returns a dict with:
        - url: Direct audio stream URL
        - title: Video title
        - duration: Duration in seconds
        - thumbnail: Thumbnail URL
        - webpage_url: YouTube video URL

    Results are cached to avoid repeated yt-dlp calls.
    """
    cache_key = query.lower().strip()

    # Check cache
    if cache_key in _stream_cache:
        entry = _stream_cache[cache_key]
        age = asyncio.get_event_loop().time() - entry.get("_cached_at", 0)
        if age < _CACHE_TTL:
            logger.info(f"Using cached stream for: {query}")
            return {k: v for k, v in entry.items() if not k.startswith("_")}

    logger.info(f"YouTube audio search: '{query}'")

    try:
        ydl_opts = _get_ydl_opts()
        search_query = f"ytsearch:{query}"

        # Run yt-dlp in a thread pool to avoid blocking
        loop = asyncio.get_event_loop()

        def _extract():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(search_query, download=False)

        info = await loop.run_in_executor(None, _extract)

        if not info or "entries" not in info or not info["entries"]:
            logger.warning(f"No YouTube results for: {query}")
            return None

        # Get the first result
        entry = info["entries"][0]
        result = {
            "url": entry.get("url", ""),
            "title": entry.get("title", ""),
            "duration": entry.get("duration", 0),
            "thumbnail": entry.get("thumbnail", ""),
            "webpage_url": entry.get("webpage_url", ""),
        }

        if not result["url"]:
            logger.warning(f"No audio URL found for YouTube result: {query}")
            return None

        # Cache the result (with size cap to prevent memory leaks)
        result["_cached_at"] = loop.time()
        if len(_stream_cache) >= _MAX_CACHE_SIZE:
            # Remove oldest entries (simple eviction)
            sorted_keys = sorted(
                _stream_cache.keys(),
                key=lambda k: _stream_cache[k].get("_cached_at", 0),
            )
            for old_key in sorted_keys[: len(sorted_keys) // 4]:  # remove oldest 25%
                del _stream_cache[old_key]
            logger.info(f"Stream cache evicted old entries, now {len(_stream_cache)}")
        _stream_cache[cache_key] = result

        logger.info(
            f"YouTube stream resolved: '{result['title']}' "
            f"({result['duration']}s)"
        )
        return {k: v for k, v in result.items() if not k.startswith("_")}

    except Exception as e:
        logger.error(f"YouTube search error for '{query}': {type(e).__name__}: {e}")
        return None


def clear_stream_cache():
    """Clear the streaming URL cache."""
    _stream_cache.clear()
    logger.info("Stream cache cleared")
