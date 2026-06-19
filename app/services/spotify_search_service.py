from spotapi import Song, Artist
from app.utils.logger import logger

# Try to import Playlist class - spotapi API differs between versions
try:
    from spotapi import Playlist  # newer versions
except ImportError:
    try:
        from spotapi.playlist import PublicPlaylist as Playlist  # older versions
    except ImportError:
        Playlist = None  # playlist search unavailable


# ── Album tracks lookup ────────────────────────────────────────────

def _find_audio_urls(obj) -> list[str]:
    """Recursively search for any HTTP URLs that look like audio/preview URLs."""
    results = []
    if isinstance(obj, dict):
        for v in obj.values():
            results.extend(_find_audio_urls(v))
    elif isinstance(obj, list):
        for v in obj:
            results.extend(_find_audio_urls(v))
    elif isinstance(obj, str):
        if obj.startswith("http") and any(
            frag in obj.lower()
            for frag in ("preview", "audio", "mp3", "aac", "ogg", "stream", "p.scdn", "audio-ak")
        ):
            results.append(obj)
    return results


def get_track_preview_url(track_id: str) -> str | None:
    """
    Get a playable audio URL for a track using SpotAPI.
    Recursively searches the track data for audio/preview URLs.
    """
    logger.info(f"Getting preview URL for track: {track_id}")
    try:
        song = Song()
        info = song.get_track_info(track_id)
        if not info or not isinstance(info, dict):
            logger.warning(f"No track info returned for {track_id}")
            return None
        track_union = info.get("data", {}).get("trackUnion", {})

        urls = _find_audio_urls(track_union)
        if urls:
            logger.info(f"Found {len(urls)} audio URLs for {track_id}")
            for url in urls:
                if "mp3" in url.lower() or "preview" in url.lower():
                    return url
            return urls[0]

        logger.warning(f"No preview URL found for track {track_id}")
        return None

    except Exception as e:
        logger.error(f"Error getting preview URL for {track_id}: {e}")
        return None


def get_album_tracks(album_id: str) -> list[dict]:
    """Fetch all tracks for a given album ID via SpotAPI."""
    logger.info(f"Fetching album tracks for: {album_id}")
    song = Song()
    # Use query_songs with the album ID - SpotAPI will resolve it
    album_data = song.query_songs(f"album:{album_id}", limit=50)
    if not album_data or not isinstance(album_data, dict):
        logger.error(f"SpotAPI returned invalid data for album {album_id}")
        return []
    search_v2 = album_data.get("data", {}).get("searchV2", {})
    
    # Look for tracks matching this album
    track_items_raw = search_v2.get("tracksV2", {}).get("items", [])
    tracks = []
    for wrapper in track_items_raw:
        item = wrapper.get("item", {})
        data = item.get("data", {})
        uri = data.get("uri", "")
        album_of_track = data.get("albumOfTrack", {})
        # Filter by album ID
        album_uri = album_of_track.get("uri", "")
        if album_id not in album_uri:
            continue
        artists_items = data.get("artists", {}).get("items", [])
        artist_names = ", ".join(
            a.get("profile", {}).get("name", "")
            for a in artists_items
        )
        cover_sources = album_of_track.get("coverArt", {}).get("sources", [])
        tracks.append({
            "name": data.get("name", ""),
            "id": _uri_to_id(uri),
            "uri": uri,
            "artists": artist_names,
            "album": album_of_track.get("name", ""),
            "album_image_url": _best_image(cover_sources),
            "duration_ms": data.get("duration", {}).get("totalMilliseconds", 0),
            "url": _uri_to_url(uri),
        })
    return tracks


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


def search_playlists_spotify(q: str, limit: int = 20) -> list[dict]:
    """Search for playlists using SpotAPI."""
    if Playlist is None:
        logger.warning(f"Playlist search unavailable - spotapi version doesn't support it")
        return []
    logger.info(f"SpotAPI playlist search: q='{q}' limit={limit}")
    try:
        playlist = Playlist()
        results = playlist.search(q, limit=limit)
        if not results or not isinstance(results, dict):
            logger.warning(f"SpotAPI playlist search returned no results for q='{q}'")
            return []

        # The response structure: data.searchV2.playlists.items[]
        search_v2 = results.get("data", {}).get("searchV2", {})
        playlist_items_raw = search_v2.get("playlists", {}).get("items", [])

        items = []
        for wrapper in playlist_items_raw:
            data = wrapper.get("data", {})
            uri = data.get("uri", "")
            owner_data = data.get("owner", {})
            owner_name = owner_data.get("name", "") if isinstance(owner_data, dict) else ""
            cover_sources = data.get("coverArt", {}).get("sources", [])
            items.append({
                "name": data.get("name", ""),
                "id": _uri_to_id(uri),
                "description": data.get("description", "") or "",
                "image_url": _best_image(cover_sources),
                "url": _uri_to_url(uri),
                "tracks_count": data.get("totalTracks", 0),
                "owner": owner_name,
            })
        logger.info(f"Found {len(items)} playlists for q='{q}'")
        return items
    except Exception as e:
        logger.error(f"Playlist search error for q='{q}': {type(e).__name__}: {e}")
        return []


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
        if not song_data or not isinstance(song_data, dict):
            logger.error(f"SpotAPI query_songs returned invalid data for q='{q}'")
            return raw
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
        if not artist_data or not isinstance(artist_data, dict):
            logger.error(f"SpotAPI query_artists returned invalid data for q='{q}'")
            return raw
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

    # Playlist search via Playlist.search
    if "playlist" in types_requested:
        playlist_items = search_playlists_spotify(q, limit=limit)
        if playlist_items:
            raw["playlists"] = {"items": playlist_items}

    return raw
