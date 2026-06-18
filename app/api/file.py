import os
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from app.services.file_service import get_downloaded_files, get_file_path
from app.models.responses import FileListResponse

router = APIRouter(prefix="/files", tags=["Files"])


@router.get("/", response_model=FileListResponse)
async def list_files():
    """Browse all downloaded files."""
    return FileListResponse(files=get_downloaded_files())


@router.get("/stream")
async def stream_file(filename: str = Query(..., description="Relative file path from downloads/")):
    """
    Stream a downloaded file (e.g., FLAC).
    Provide ?filename=Artist/Album/01 Track.flac
    """
    try:
        path = get_file_path(filename)
        ext = os.path.splitext(path)[1].lower()
        media_type_map = {
            ".flac": "audio/flac",
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".wav": "audio/wav",
            ".ogg": "audio/ogg",
        }
        media_type = media_type_map.get(ext, "application/octet-stream")
        return FileResponse(
            path=path,
            media_type=media_type,
            filename=os.path.basename(filename),
        )
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=404, detail=str(e))
