import json
import urllib.parse
import urllib.request
from app.utils.logger import logger

ITUNES_SEARCH_URL = "https://itunes.apple.com/search"

# Map our search type names to iTunes entity values
ITUNES_ENTITY_MAP = {
    "track": "musicTrack",
    "album": "album",
    "artist": "musicArtist",
}


def _itunes_search(query: str, entity: str, limit: int, country: str) -> list[dict]:
    """Call the iTunes Search API for a single entity type."""
    params = urllib.parse.urlencode({
        "term": query,
        "entity": entity,
        "limit": limit,
        "country": country,
    })
    url = f"{ITUNES_SEARCH_URL}?{params}"

    logger.info(f"iTunes search: entity={entity} q='{query}'")
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    return data.get("results", [])


def _make_spotify_url(artist_name: str, track_or_album: str = "") -> str:
    """Build a Spotify search URL from artist and optional track/album name."""
    if track_or_album:
        query = f"{artist_name} {track_or_album}"
    else:
        query = artist_name
    return f"https://open.spotify.com/search/{urllib.parse.quote(query)}"


def _hi_res_artwork(url: str) -> str:
    """Convert iTunes 100x100 artwork URL to 600x600."""
    return url.replace("100x100bb.jpg", "600x600bb.jpg") if url else ""


def search_spotify(q: str, search_type: str, limit: int, market: str) -> dict:
    """
    Search for music using the iTunes Search API (free, no auth).
    Returns a dict compatible with the old Spotify response structure
    so existing parsing in search.py works with minimal changes.
    """
    logger.info(f"Search via iTunes: q='{q}' type={search_type} limit={limit}")

    types_requested = set(t.strip() for t in search_type.split(","))
    raw: dict[str, list] = {}

    for stype in ("track", "album", "artist"):
        if stype not in types_requested:
            continue
        entity = ITUNES_ENTITY_MAP.get(stype)
        if not entity:
            continue
        results = _itunes_search(q, entity, limit, market)

        items = []
        for item in results:
            wrapper = item.get("wrapperType", "")
            if wrapper == "track":
                name = item.get("trackName", "")
                artist_name = item.get("artistName", "")
                album_name = item.get("collectionName", "")
                artwork = _hi_res_artwork(item.get("artworkUrl100", ""))
                items.append({
                    "name": name,
                    "id": str(item.get("trackId", "")),
                    "artists": artist_name,
                    "album": album_name,
                    "album_image_url": artwork,
                    "duration_ms": item.get("trackTimeMillis", 0),
                    "preview_url": item.get("previewUrl"),
                    "url": _make_spotify_url(artist_name, name),
                })
            elif wrapper == "collection":
                name = item.get("collectionName", "")
                artist_name = item.get("artistName", "")
                artwork = _hi_res_artwork(item.get("artworkUrl100", ""))
                items.append({
                    "name": name,
                    "id": str(item.get("collectionId", "")),
                    "artists": artist_name,
                    "release_date": item.get("releaseDate", ""),
                    "total_tracks": item.get("trackCount", 0),
                    "image_url": artwork,
                    "url": _make_spotify_url(artist_name, name),
                })
            elif wrapper == "artist":
                name = item.get("artistName", "")
                items.append({
                    "name": name,
                    "id": str(item.get("artistId", "")),
                    "genres": item.get("primaryGenreName", ""),
                    "image_url": "",
                    "url": _make_spotify_url(name),
                })

        if stype == "track":
            raw["tracks"] = {"items": items}
        elif stype == "album":
            raw["albums"] = {"items": items}
        elif stype == "artist":
            raw["artists"] = {"items": items}

    return raw
