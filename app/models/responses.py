from pydantic import BaseModel
from typing import List, Optional


class BaseResponse(BaseModel):
    message: str


class FileItem(BaseModel):
    filename: str          # relative path from downloads/
    size_mb: float
    extension: str


class FileListResponse(BaseModel):
    files: List[FileItem]


class DownloadStatus(BaseModel):
    url: str
    status: str            # "queued" | "downloading" | "complete" | "failed
