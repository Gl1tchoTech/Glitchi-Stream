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


class SpotifyArtist(BaseModel):
    name: str
    id: str
    uri: str
    genres: str = ""
    followers: int = 0
    image_url: str = ""
    url: str = ""


class SpotifyAlbum(BaseModel):
    name: str
    id: str
    uri: str
    artists: str = ""
    release_date: str = ""
    total_tracks: int = 0
    image_url: str = ""
    url: str = ""


class SpotifyTrack(BaseModel):
    name: str
    id: str
    uri: str
    artists: str = ""
    album: str = ""
    album_image_url: str = ""
    duration_ms: int = 0
    explicit: bool = False
    popularity: int = 0
    preview_url: Optional[str] = None
    url: str = ""


class SearchResults(BaseModel):
    tracks: List[SpotifyTrack] = []
    albums: List[SpotifyAlbum] = []
    artists: List[SpotifyArtist] = []
    query: str = ""
