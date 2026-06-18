from fastapi import APIRouter, BackgroundTasks, HTTPException
from app.models.requests import DownloadRequest
from app.models.responses import BaseResponse
from app.services.spotiflac_service import execute_download
from app.utils.validators import is_spotify_url

router = APIRouter(prefix="/download", tags=["Download"])


@router.post("/", response_model=BaseResponse)
async def trigger_download(req: DownloadRequest, bg_tasks: BackgroundTasks):
    """
    Queue a Spotify URL for download. SpotiFLAC runs in the background.
    Supports tracks, albums, playlists, and artist discographies.
    """
    if not is_spotify_url(str(req.url)):
        raise HTTPException(status_code=400, detail="Not a valid Spotify URL")

    bg_tasks.add_task(execute_download, req)
    return BaseResponse(message="Download queued successfully")
