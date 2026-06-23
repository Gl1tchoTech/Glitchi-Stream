from spotapi import Song, Artist
from app.utils.logger import logger


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
    try:
        return _get_album_tracks_impl(album_id)
    except Exception as e:
        logger.error(f"get_album_tracks crash for {album_id}: {type(e).__name__}: {e}")
        return []


def _get_album_tracks_impl(album_id: str) -> list[dict]:
    """Search for tracks belonging to a specific album via SpotAPI query_songs."""
    try:
        song = Song()
        data = song.query_songs(album_id, limit=50)
    except Exception as e:
        logger.error(f"query_songs failed for album {album_id}: {type(e).__name__}: {e}")
        return []

    if not data or not isinstance(data, dict):
        return []

    search_v2 = data.get("data", {}).get("searchV2", {})
    if not isinstance(search_v2, dict):
        return []

    # Look for tracks matching this album
    track_items_raw = _safe_dict(_safe_dict(search_v2, "tracksV2", {}), "items", [])
    if not isinstance(track_items_raw, list):
        return []
    tracks = []
    for wrapper in track_items_raw:
        if not isinstance(wrapper, dict):
            continue
        item = wrapper.get("item", {})
        if not isinstance(item, dict):
            continue
        data = item.get("data", {})
        if not isinstance(data, dict):
            continue
        uri = data.get("uri", "")
        album_of_track = data.get("albumOfTrack", {})
        if not isinstance(album_of_track, dict):
            continue
        # Filter by album ID
        album_uri = album_of_track.get("uri", "")
        if album_id not in album_uri:
            continue
        artists_items = _safe_dict(_safe_dict(data, "artists", {}), "items", [])
        if not isinstance(artists_items, list):
            artists_items = []
        artist_names = ", ".join(
            _safe_dict(_safe_dict(a, "profile", {}), "name", "")
            for a in artists_items if isinstance(a, dict)
        )
        cover_sources = _safe_dict(_safe_dict(album_of_track, "coverArt", {}), "sources", [])
        if not isinstance(cover_sources, list):
            cover_sources = []
        duration_data = data.get("duration", {})
        duration_ms = duration_data.get("totalMilliseconds", 0) if isinstance(duration_data, dict) else 0
        tracks.append({
            "name": data.get("name", ""),
            "id": _uri_to_id(uri),
            "uri": uri,
            "artists": artist_names,
            "album": album_of_track.get("name", ""),
            "album_image_url": _best_image(cover_sources),
            "duration_ms": duration_ms,
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
    valid = [s for s in sources if isinstance(s, dict)]
    if not valid:
        return ""
    best = max(valid, key=lambda s: s.get("width", 0) * s.get("height", 0))
    return best.get("url", "")


def search_playlists_spotify(q: str, limit: int = 20) -> list[dict]:
    """Search for playlists using Song.query_songs (searchV2.playlists).

    The newer spotapi PublicPlaylist API requires a playlist URL/ID in its
    constructor and doesn't support free-text searching.  We extract playlist
    results from Song.query_songs instead.
    """
    logger.info(f"SpotAPI playlist search: q='{q}' limit={limit}")
    try:
        song = Song()
        results = song.query_songs(q, limit=limit)
    except Exception as e:
        logger.error(f"SpotAPI playlist search crash for q='{q}': {type(e).__name__}: {e}")
        return []

    if not results or not isinstance(results, dict):
        logger.warning(f"SpotAPI playlist search returned no results for q='{q}'")
        return []

    search_v2 = _safe_dict(_safe_dict(results, "data", {}), "searchV2", {})
    if not isinstance(search_v2, dict):
        return []

    items = _parse_playlist_items(search_v2)
    logger.info(f"Found {len(items)} playlists for q='{q}'")
    return items


def _parse_playlist_items(search_v2: dict) -> list[dict]:
    """Extract playlist items from a searchV2 response."""
    playlist_items_raw = _safe_dict(_safe_dict(search_v2, "playlists", {}), "items", [])
    if not isinstance(playlist_items_raw, list):
        return []
    items = []
    for wrapper in playlist_items_raw:
        if not isinstance(wrapper, dict):
            continue
        data = wrapper.get("data", {})
        if not isinstance(data, dict):
            continue
        uri = data.get("uri", "")
        owner_data = data.get("owner", {})
        owner_name = owner_data.get("name", "") if isinstance(owner_data, dict) else ""
        cover_sources = _safe_dict(_safe_dict(data, "coverArt", {}), "sources", [])
        if not isinstance(cover_sources, list):
            cover_sources = []
        items.append({
            "name": data.get("name", ""),
            "id": _uri_to_id(uri),
            "description": data.get("description", "") or "",
            "image_url": _best_image(cover_sources),
            "url": _uri_to_url(uri),
            "tracks_count": data.get("totalTracks", 0),
            "owner": owner_name,
        })
    return items


def _safe_dict(d, key, default=None):
    """Get key from dict, returning default if value is None or missing."""
    if not isinstance(d, dict):
        return default
    v = d.get(key, default)
    return v if v is not None else default


# ── Browse / Discover ──────────────────────────────────────────────

# Genre & mood categories for the Song Browser
BROWSE_CATEGORIES = [
    {"id": "pop", "name": "Pop", "color": "#ec407a"},
    {"id": "rock", "name": "Rock", "color": "#ef5350"},
    {"id": "hip-hop", "name": "Hip-Hop", "color": "#ff9800"},
    {"id": "electronic", "name": "Electronic", "color": "#00bcd4"},
    {"id": "rnb", "name": "R&B", "color": "#9c27b0"},
    {"id": "jazz", "name": "Jazz", "color": "#8d6e63"},
    {"id": "classical", "name": "Classical", "color": "#78909c"},
    {"id": "country", "name": "Country", "color": "#a1887f"},
    {"id": "latin", "name": "Latin", "color": "#f44336"},
    {"id": "k-pop", "name": "K-Pop", "color": "#e91e63"},
    {"id": "indie", "name": "Indie", "color": "#66bb6a"},
    {"id": "metal", "name": "Metal", "color": "#424242"},
    {"id": "reggae", "name": "Reggae", "color": "#2e7d32"},
    {"id": "blues", "name": "Blues", "color": "#1565c0"},
    {"id": "folk", "name": "Folk", "color": "#795548"},
    {"id": "chill", "name": "Chill", "color": "#4fc3f7"},
    {"id": "workout", "name": "Workout", "color": "#ff5722"},
    {"id": "focus", "name": "Focus", "color": "#5c6bc0"},
    {"id": "party", "name": "Party", "color": "#ff4081"},
    {"id": "sleep", "name": "Sleep", "color": "#3f51b5"},
    {"id": "romance", "name": "Romance", "color": "#e91e63"},
    {"id": "gaming", "name": "Gaming", "color": "#76ff03"},
    {"id": "travel", "name": "Travel", "color": "#00acc1"},
    {"id": "retro", "name": "Retro", "color": "#ff6f00"},
]


def browse_by_category(category_id: str, limit: int = 20) -> dict:
    """Get playlists and tracks for a genre/mood category."""
    logger.info(f"Browse category: '{category_id}' limit={limit}")
    cat = next((c for c in BROWSE_CATEGORIES if c["id"] == category_id), None)
    search_term = cat["name"] if cat else category_id
    # Search for playlists + tracks in this category
    return search_spotify(
        q=f"{search_term} mix",
        search_type="playlist,track",
        limit=limit,
        market="US",
    )


def get_new_releases(limit: int = 20) -> dict:
    """Get new album releases."""
    logger.info(f"New releases: limit={limit}")
    # Search for recent albums
    return search_spotify(
        q="new releases",
        search_type="album,track",
        limit=limit,
        market="US",
    )


def get_featured_playlists(limit: int = 20) -> dict:
    """Get featured/curated playlists."""
    logger.info(f"Featured playlists: limit={limit}")
    return search_spotify(
        q="top playlists",
        search_type="playlist,track",
        limit=limit,
        market="US",
    )


def search_spotify(q: str, search_type: str, limit: int, market: str) -> dict:
    """
    Search Spotify via SpotAPI (no credentials needed).
    Kinda sus but it works.
    """
    logger.info(f"SpotAPI search: q='{q}' type={search_type} limit={limit}")

    try:
        return _search_spotify_impl(q, search_type, limit, market)
    except Exception as e:
        logger.error(f"search_spotify crash for q='{q}': {type(e).__name__}: {e}")
        return {}


def _search_spotify_impl(q: str, search_type: str, limit: int, market: str) -> dict:
    types_requested = set(t.strip() for t in search_type.split(","))
    raw: dict[str, list] = {}

    # Fetch searchV2 once for tracks, albums, AND playlists
    # (Song.query_songs returns tracksV2, albumsV2, and playlists)
    need_query_songs = types_requested & {"track", "album", "playlist"}
    search_v2: dict = {}

    if need_query_songs:
        try:
            song = Song()
            song_data = song.query_songs(q, limit=limit)
        except Exception as e:
            logger.error(f"SpotAPI query_songs exception for q='{q}': {type(e).__name__}: {e}")
            song_data = None
        if not song_data or not isinstance(song_data, dict):
            logger.error(f"SpotAPI query_songs returned invalid data for q='{q}'")
            song_data = {}
        search_v2 = song_data.get("data", {}).get("searchV2", {})
        if not isinstance(search_v2, dict):
            search_v2 = {}

        if "track" in types_requested:
            track_items_raw = search_v2.get("tracksV2", {}).get("items", [])
            if not isinstance(track_items_raw, list):
                track_items_raw = []
            track_items = []
            for wrapper in track_items_raw:
                if not isinstance(wrapper, dict):
                    continue
                item = wrapper.get("item", {})
                if not isinstance(item, dict):
                    continue
                data = item.get("data", {})
                if not isinstance(data, dict):
                    continue
                uri = data.get("uri", "")
                album_data = data.get("albumOfTrack", {})
                if not isinstance(album_data, dict):
                    album_data = {}
                artists_items = _safe_dict(data, "artists", {}).get("items", [])
                if not isinstance(artists_items, list):
                    artists_items = []
                artist_names = ", ".join(
                    _safe_dict(_safe_dict(a, "profile", {}), "name", "")
                    for a in artists_items if isinstance(a, dict)
                )
                cover_sources = _safe_dict(album_data, "coverArt", {}).get("sources", [])
                if not isinstance(cover_sources, list):
                    cover_sources = []
                duration_data = data.get("duration", {})
                duration_ms = duration_data.get("totalMilliseconds", 0) if isinstance(duration_data, dict) else 0
                track_items.append({
                    "name": data.get("name", ""),
                    "id": _uri_to_id(uri),
                    "uri": uri,
                    "artists": artist_names,
                    "album": album_data.get("name", ""),
                    "album_image_url": _best_image(cover_sources),
                    "duration_ms": duration_ms,
                    "preview_url": None,
                    "url": _uri_to_url(uri),
                })
            raw["tracks"] = {"items": track_items}

        if "album" in types_requested:
            album_items_raw = search_v2.get("albumsV2", {}).get("items", [])
            if not isinstance(album_items_raw, list):
                album_items_raw = []
            album_items = []
            for wrapper in album_items_raw:
                if not isinstance(wrapper, dict):
                    continue
                data = wrapper.get("data", {})
                if not isinstance(data, dict):
                    continue
                uri = data.get("uri", "")
                artists_items = _safe_dict(data, "artists", {}).get("items", [])
                if not isinstance(artists_items, list):
                    artists_items = []
                artist_names = ", ".join(
                    _safe_dict(_safe_dict(a, "profile", {}), "name", "")
                    for a in artists_items if isinstance(a, dict)
                )
                cover_sources = _safe_dict(data, "coverArt", {}).get("sources", [])
                if not isinstance(cover_sources, list):
                    cover_sources = []
                date_data = _safe_dict(data, "date", {})
                release_year = str(date_data.get("year", "")) if isinstance(date_data, dict) else ""
                album_items.append({
                    "name": data.get("name", ""),
                    "id": _uri_to_id(uri),
                    "uri": uri,
                    "artists": artist_names,
                    "release_date": release_year,
                    "total_tracks": 0,
                    "image_url": _best_image(cover_sources),
                    "url": _uri_to_url(uri),
                })
            raw["albums"] = {"items": album_items}

    # Artist search via Artist.query_artists
    if "artist" in types_requested:
        try:
            artist = Artist()
            artist_data = artist.query_artists(q, limit=limit)
        except Exception as e:
            logger.error(f"SpotAPI query_artists exception for q='{q}': {type(e).__name__}: {e}")
            artist_data = None
        if not artist_data or not isinstance(artist_data, dict):
            logger.error(f"SpotAPI query_artists returned invalid data for q='{q}'")
            artist_data = {}
        search_v2 = artist_data.get("data", {}).get("searchV2", {})
        if not isinstance(search_v2, dict):
            search_v2 = {}
        artist_items_raw = search_v2.get("artists", {}).get("items", [])
        if not isinstance(artist_items_raw, list):
            artist_items_raw = []

        artist_items = []
        for wrapper in artist_items_raw:
            if not isinstance(wrapper, dict):
                continue
            data = wrapper.get("data", {})
            if not isinstance(data, dict):
                continue
            uri = data.get("uri", "")
            visuals = _safe_dict(data, "visuals", {})
            avatar_image = _safe_dict(visuals, "avatarImage", {})
            avatar_sources = avatar_image.get("sources", []) if isinstance(avatar_image, dict) else []
            if not isinstance(avatar_sources, list):
                avatar_sources = []
            profile = _safe_dict(data, "profile", {})
            profile_name = profile.get("name", "") if isinstance(profile, dict) else ""
            artist_items.append({
                "name": profile_name,
                "id": _uri_to_id(uri),
                "uri": uri,
                "genres": "",
                "followers": 0,
                "image_url": _best_image(avatar_sources),
                "url": _uri_to_url(uri),
            })
        raw["artists"] = {"items": artist_items}

    # Playlist search — if query_songs was already called, extract from search_v2;
    # otherwise do a dedicated search (covers edge case where only type=playlist)
    if "playlist" in types_requested:
        playlist_items = _parse_playlist_items(search_v2) if search_v2 else []
        if not playlist_items:
            playlist_items = search_playlists_spotify(q, limit=limit)
        if playlist_items:
            raw["playlists"] = {"items": playlist_items}

    return raw
