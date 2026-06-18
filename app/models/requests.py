from pydantic import BaseModel, HttpUrl
from typing import Optional, List


class DownloadRequest(BaseModel):
    url: HttpUrl
    services: Optional[List[str]] = ["qobuz", "tidal"]
    quality: Optional[str] = "LOSSLESS"
    timeout_s: Optional[int] = 10
    track_max_retries: Optional[int] = 3
