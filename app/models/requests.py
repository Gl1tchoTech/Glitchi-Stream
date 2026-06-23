from pydantic import BaseModel, HttpUrl
from typing import Optional, List


class DownloadRequest(BaseModel):
    url: HttpUrl
    services: Optional[List[str]] = ["qobuz", "tidal"]
    quality: Optional[str] = "LOSSLESS"
    timeout_s: Optional[int] = 10
    track_max_retries: Optional[int] = 3
    downloader: Optional[str] = None  # spotiflac | ytdlp | spotdl (overrides default)
    artist: Optional[str] = None  # from frontend search results (SpotAPI returns these)
    title: Optional[str] = None   # from frontend search results


class SearchRequest(BaseModel):
    q: str
    type: str = "track,album,artist"
    limit: int = 20
    market: str = "US"
