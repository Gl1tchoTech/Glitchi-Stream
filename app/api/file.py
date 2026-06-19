import os
import mimetypes
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from app.services.file_service import get_downloaded_files, get_file_path
from app.services.spotify_search_service import get_track_preview_url
from app.models.responses import FileListResponse

router = APIRouter(prefix="/files", tags=["Files"])

# Ensure MIME types are properly registered
_mime_init = False
def _ensure_mime_types():
    global _mime_init
    if _mime_init:
        return
    _mime_init = True
    # Register common audio types (idempotent, safe to always call)
    for ext, mime in [
        (".flac", "audio/flac"),
        (".mp3", "audio/mpeg"),
        (".m4a", "audio/mp4"),
        (".wav", "audio/wav"),
        (".ogg", "audio/ogg"),
        (".opus", "audio/opus"),
        (".aac", "audio/aac"),
        (".wma", "audio/x-ms-wma"),
    ]:
        mimetypes.add_type(mime, ext, strict=False)

_ensure_mime_types()


@router.get("/", response_model=FileListResponse)
async def list_files():
    return FileListResponse(files=get_downloaded_files())


@router.get("/stream")
@router.head("/stream")
async def stream_file(
    request: Request,
    filename: str = Query(..., description="Relative file path from downloads/"),
):
    """
    Stream an audio file with proper Range request support.
    Returns Content-Disposition: inline so browsers play instead of download.
    Supports HEAD requests for audio preflight checks.
    """
    try:
        path = get_file_path(filename)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    file_size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()

    # Determine media type
    media_type, _ = mimetypes.guess_type(path)
    if not media_type:
        media_type_map = {
            ".flac": "audio/flac",
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".wav": "audio/wav",
            ".ogg": "audio/ogg",
            ".opus": "audio/opus",
            ".aac": "audio/aac",
        }
        media_type = media_type_map.get(ext, "application/octet-stream")

    # HEAD request: return headers only (used by audio players for preflight)
    if request.method == "HEAD":
        headers = {
            "Content-Type": media_type,
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
            "Content-Disposition": f'inline; filename="{os.path.basename(filename)}"',
        }
        return Response(headers=headers, status_code=200)

    # GET with Range support
    range_header = request.headers.get("range", "")

    if range_header and range_header.startswith("bytes="):
        # Parse the range request
        try:
            range_val = range_header[6:]  # strip "bytes="
            if "-" in range_val:
                start_str, end_str = range_val.split("-", 1)
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
            else:
                start = int(range_val)
                end = file_size - 1
        except (ValueError, IndexError):
            # Malformed range, return full file
            start, end = 0, file_size - 1
        else:
            # Clamp to valid range
            start = max(0, min(start, file_size - 1))
            end = max(start, min(end, file_size - 1))

        chunk_size = end - start + 1

        # Stream the requested range
        def range_stream():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    chunk = f.read(min(8192, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": media_type,
            "Content-Disposition": "inline",
        }
        return StreamingResponse(
            content=range_stream(),
            status_code=206,
            headers=headers,
            media_type=media_type,
        )

    # Full file response (no Range header) — use FileResponse with inline disposition
    return FileResponse(
        path=path,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Disposition": "inline",
        },
    )


@router.get("/stream/preview/{track_id}")
async def stream_preview(track_id: str):
    """
    Get a playable audio URL for a Spotify track preview.
    Returns a redirect to Spotify's CDN preview URL.
    """
    preview_url = get_track_preview_url(track_id)
    if not preview_url:
        raise HTTPException(
            status_code=404,
            detail="No preview available for this track. Try downloading it first.",
        )

    return RedirectResponse(url=preview_url, status_code=302)


@router.get("/download/{filename:path}")
@router.head("/download/{filename:path}")
async def download_file(request: Request, filename: str):
    """Download a file with Content-Disposition: attachment."""
    try:
        path = get_file_path(filename)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    if request.method == "HEAD":
        headers = {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(os.path.getsize(path)),
            "Accept-Ranges": "bytes",
        }
        return Response(headers=headers, status_code=200)

    return FileResponse(
        path=path,
        media_type="application/octet-stream",
        filename=os.path.basename(filename),
    )
