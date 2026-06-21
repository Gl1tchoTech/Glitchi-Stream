"""Streaming API — yt-dlp powered, zero-download audio proxy.

Uses the :mod:`app.services.ytdlp_streamer` module to resolve a YouTube
audio URL from a search query and proxy it to the client in real time.
No files are ever written to disk.
"""

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.services import ytdlp_streamer
from app.utils.logger import logger

router = APIRouter(prefix="/stream", tags=["Stream"])


@router.get("/audio")
async def stream_audio(
    request: Request,
    q: str = Query(..., description="Search query (track name + artist)", min_length=1),
):
    """Stream audio from YouTube via yt-dlp.

    Searches YouTube for *q*, extracts the best audio stream URL **without
    downloading**, then proxies the audio to the browser in 64 KiB chunks.
    """
    # Resolve stream URL via yt-dlp (download=False — zero disk I/O)
    result = await ytdlp_streamer.resolve_stream(q)
    if not result or not result.get("url"):
        raise HTTPException(status_code=404, detail=f"No stream found for: {q}")

    audio_url = result["url"]
    content_type = ytdlp_streamer.guess_content_type(audio_url)
    safe_title = result.get("title", "stream").replace('"', "'")

    return StreamingResponse(
        ytdlp_streamer.stream_audio_chunks(audio_url, q),
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
    """Get stream metadata (title, duration, thumbnail) without playing."""
    result = await ytdlp_streamer.resolve_stream(q)
    if not result:
        raise HTTPException(status_code=404, detail=f"No stream found for: {q}")
    return {
        "title": result.get("title", ""),
        "duration": result.get("duration", 0),
        "thumbnail": result.get("thumbnail", ""),
        "webpage_url": result.get("webpage_url", ""),
    }
