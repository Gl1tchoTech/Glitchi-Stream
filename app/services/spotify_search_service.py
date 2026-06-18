from spotapi import Song, Artist
from app.utils.logger import logger


def _uri_to_url(uri: str) -> str:
    """Convert spotify:track:XXX → https://open.spotify.com/track/XXX"""
    if not uri or ":" not in uri:
        return ""
    parts = uri.split(":")
    if len(parts) >= 3:
        entity_type = parts[1]
        entity_id = parts[2]
        return f"https://open.spotify.com/{entity_type}/{entity_id}"
    return ""


def _uri_to_id(uri: str) -> str:
    """Extract the ID from a Spotify URI."""
    if not uri or ":" not in uri:
        return ""
    return uri.rsplit(":", 1)[-1]


def _best_image(sources: list) -> str:
    """Pick the best image URL from a list of sources."""
    if not sources:
        return ""
    best = max(sources, key=lambda s: s.get("width", 0) * s.get("height", 0))
    return best.get("url", "")


def search_spotify(q: str, search_type: str, limit: int, market: str) -> dict:
    """
    Search Spotify via SpotAPI (no credentials needed).
    Kinda sus but it works.
    """
    logger.info(f"SpotAPI search: q='{q}' type={search_type} limit={limit}")

    types_requested = set(t.strip() for t in search_type.split(","))
    raw: dict[str, list] = {}

    # Track & Album search via Song.query_songs (returns both tracksV2 + albumsV2)
    if "track" in types_requested or "album" in types_requested:
        song = Song()
        song_data = song.query_songs(q, limit=limit)
        search_v2 = song_data.get("data", {}).get("searchV2", {})

        if "track" in types_requested:
            track_items_raw = (
                search_v2.get("tracksV2", {}).get("items", [])
            )
            track_items = []
            for wrapper in track_items_raw:
                item = wrapper.get("item", {})
                data = item.get("data", {})
                uri = data.get("uri", "")
                album_data = data.get("albumOfTrack", {})
                artists_items = data.get("artists", {}).get("items", [])
                artist_names = ", ".join(
                    a.get("profile", {}).get("name", "")
                    for a in artists_items
                )
                cover_sources = album_data.get("coverArt", {}).get("sources", [])
                track_items.append({
                    "name": data.get("name", ""),
                    "id": _uri_to_id(uri),
                    "uri": uri,
                    "artists": artist_names,
                    "album": album_data.get("name", ""),
                    "album_image_url": _best_image(cover_sources),
                    "duration_ms": data.get("duration", {}).get("totalMilliseconds", 0),
                    "preview_url": None,
                    "url": _uri_to_url(uri),
                })
            raw["tracks"] = {"items": track_items}

        if "album" in types_requested:
            album_items_raw = (
                search_v2.get("albumsV2", {}).get("items", [])
            )
            album_items = []
            for wrapper in album_items_raw:
                data = wrapper.get("data", {})
                uri = data.get("uri", "")
                artists_items = data.get("artists", {}).get("items", [])
                artist_names = ", ".join(
                    a.get("profile", {}).get("name", "")
                    for a in artists_items
                )
                cover_sources = data.get("coverArt", {}).get("sources", [])
                album_items.append({
                    "name": data.get("name", ""),
                    "id": _uri_to_id(uri),
                    "uri": uri,
                    "artists": artist_names,
                    "release_date": str(data.get("date", {}).get("year", "")),
                    "total_tracks": 0,
                    "image_url": _best_image(cover_sources),
                    "url": _uri_to_url(uri),
                })
            raw["albums"] = {"items": album_items}

    # Artist search via Artist.query_artists
    if "artist" in types_requested:
        artist = Artist()
        artist_data = artist.query_artists(q, limit=limit)
        search_v2 = artist_data.get("data", {}).get("searchV2", {})
        artist_items_raw = search_v2.get("artists", {}).get("items", [])

        artist_items = []
        for wrapper in artist_items_raw:
            data = wrapper.get("data", {})
            uri = data.get("uri", "")
            avatar_sources = (
                data.get("visuals", {})
                .get("avatarImage", {})
                .get("sources", [])
            )
            artist_items.append({
                "name": data.get("profile", {}).get("name", ""),
                "id": _uri_to_id(uri),
                "uri": uri,
                "genres": "",
                "followers": 0,
                "image_url": _best_image(avatar_sources),
                "url": _uri_to_url(uri),
            })
        raw["artists"] = {"items": artist_items}

    return raw
