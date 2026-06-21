"""Streaming API — yt-dlp powered, zero-download audio proxy.

Uses :mod:`app.services.ytdlp_streamer` to pipe yt-dlp audio directly
to the browser via subprocess stdout.  **No files are ever written to disk.**
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.services import ytdlp_streamer

router = APIRouter(prefix="/stream", tags=["Stream"])


@router.get("/audio")
async def stream_audio(
    q: str = Query(..., description="Search query (track name + artist)", min_length=1),
):
    """Stream audio from YouTube via yt-dlp subprocess stdout.

    yt-dlp searches YouTube, picks the best audio format, and remuxes it
to stdout.  We stream those bytes to the browser as they arrive.
    **Zero bytes touch the disk.**

    No ``Content-Disposition`` header is set so the browser treats this
    as progressive streaming media, not a file download.
    """
    return StreamingResponse(
        ytdlp_streamer.stream_audio_chunks(q),
        media_type="audio/webm",
        headers={
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
