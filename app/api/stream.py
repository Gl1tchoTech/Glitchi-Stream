"""Streaming API - YouTube audio proxy.

Proxies YouTube audio streams to the client so they can play music
without downloading first and without needing any API keys.
"""

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
import httpx
from app.services.streaming_service import search_youtube_audio
from app.utils.logger import logger

router = APIRouter(prefix="/stream", tags=["Stream"])


@router.get("/audio")
async def stream_audio(
    request: Request,
    q: str = Query(..., description="Search query (track name + artist)", min_length=1),
):
    """Stream audio from YouTube based on search query.

    Searches YouTube for the given query, extracts the best audio stream,
    and proxies it to the client. No download required - plays instantly.
    """
    # Search YouTube for the audio
    result = await search_youtube_audio(q)
    if not result or not result.get("url"):
        raise HTTPException(
            status_code=404,
            detail=f"No stream found for: {q}",
        )

    audio_url = result["url"]

    # Stream the audio through our server to avoid IP restrictions
    async def audio_stream():
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
                async with client.stream("GET", audio_url, follow_redirects=True) as response:
                    if response.status_code >= 400:
                        logger.error(
                            f"YouTube stream error: HTTP {response.status_code} for {q}"
                        )
                        return
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        yield chunk
        except httpx.ReadTimeout:
            logger.warning(f"Stream timeout for: {q}")
        except Exception as e:
            logger.error(f"Stream proxy error for '{q}': {type(e).__name__}: {e}")

    # Detect the content type from the URL extension or default to audio/mp4
    content_type = "audio/mp4"
    if ".mp3" in audio_url.lower():
        content_type = "audio/mpeg"
    elif ".webm" in audio_url.lower():
        content_type = "audio/webm"
    elif ".ogg" in audio_url.lower() or ".opus" in audio_url.lower():
        content_type = "audio/ogg"

    safe_title = result.get("title", "stream").replace('"', "'")
    return StreamingResponse(
        audio_stream(),
        media_type=content_type,
        headers={
            "Content-Disposition": f'inline; filename="{safe_title}"',
            "Cache-Control": "no-cache",
            "Accept-Ranges": "none",
        },
    )


@router.get("/info")
async def stream_info(
    q: str = Query(..., description="Search query", min_length=1),
):
    """Get stream metadata without starting playback.

    Returns the YouTube video title, duration, and thumbnail
    so the frontend can update the player UI before streaming.
    """
    result = await search_youtube_audio(q)
    if not result:
        raise HTTPException(
            status_code=404,
            detail=f"No stream found for: {q}",
        )
    return {
        "title": result.get("title", ""),
        "duration": result.get("duration", 0),
        "thumbnail": result.get("thumbnail", ""),
        "webpage_url": result.get("webpage_url", ""),
    }
