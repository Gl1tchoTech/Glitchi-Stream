from pydantic import BaseModel
from typing import List, Optional


class BaseResponse(BaseModel):
    message: str


class FileItem(BaseModel):
    filename: str
    size_mb: float
    extension: str


class FileListResponse(BaseModel):
    files: List[FileItem]


class Artist(BaseModel):
    name: str
    id: str = ""
    genres: str = ""
    image_url: str = ""
    url: str = ""


class Album(BaseModel):
    name: str
    id: str = ""
    artists: str = ""
    release_date: str = ""
    total_tracks: int = 0
    image_url: str = ""
    url: str = ""


class Track(BaseModel):
    name: str
    id: str = ""
    artists: str = ""
    album: str = ""
    album_image_url: str = ""
    duration_ms: int = 0
    preview_url: Optional[str] = None
    url: str = ""


class Playlist(BaseModel):
    name: str
    id: str = ""
    description: str = ""
    image_url: str = ""
    url: str = ""
    tracks_count: int = 0
    owner: str = ""


class SearchResults(BaseModel):
    tracks: List[Track] = []
    albums: List[Album] = []
    artists: List[Artist] = []
    playlists: List[Playlist] = []
    query: str = ""
