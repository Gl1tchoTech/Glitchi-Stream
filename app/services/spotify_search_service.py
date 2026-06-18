import json
import time
import urllib.parse
import urllib.request
from app.utils.logger import logger

_token_cache = {
    "token": None,
    "expires_at": 0,
}


def _get_guest_token() -> str:
    """Fetch an anonymous guest access token from Spotify's web player API."""
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    token_url = (
        "https://open.spotify.com/get_access_token"
        "?reason=transport&productType=web_player"
    )
    req = urllib.request.Request(token_url)
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())

    _token_cache["token"] = data["accessToken"]
    # Subtract 60s buffer before actual expiry
    _token_cache["expires_at"] = (
        data["accessTokenExpirationTimestampMs"] / 1000.0
    ) - 60

    logger.info("Fetched new Spotify guest access token")
    return _token_cache["token"]


def search_spotify(q: str, search_type: str, limit: int, market: str) -> dict:
    """Query Spotify search using a guest access token (no credentials needed)."""
    logger.info(f"Spotify search: q='{q}' type={search_type} limit={limit}")

    token = _get_guest_token()

    params = urllib.parse.urlencode({
        "q": q,
        "type": search_type,
        "limit": limit,
        "market": market,
    })
    url = f"https://api.spotify.com/v1/search?{params}"

    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())
