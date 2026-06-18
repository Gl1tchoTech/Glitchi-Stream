import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from app.config import settings
from app.utils.logger import logger

_sp = None


def get_spotify_client() -> spotipy.Spotify:
    global _sp
    if _sp is None:
        auth = SpotifyClientCredentials(
            client_id=settings.SPOTIFY_CLIENT_ID,
            client_secret=settings.SPOTIFY_CLIENT_SECRET,
        )
        _sp = spotipy.Spotify(auth_manager=auth)
    return _sp


def search_spotify(q: str, search_type: str, limit: int, market: str) -> dict:
    sp = get_spotify_client()
    logger.info(f"Spotify search: q='{q}' type={search_type} limit={limit}")
    return sp.search(q=q, type=search_type, limit=limit, market=market)
