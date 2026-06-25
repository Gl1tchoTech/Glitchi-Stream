"""Browse API — discover music by category, genre, mood, and trending.
All data sourced from Spotify via SpotAPI (no credentials needed)."""

from fastapi import APIRouter, HTTPException, Query
from app.models.responses import SearchResults, Track, Album, Playlist
from app.services.spotify_search_service import (
    search_spotify,
    browse_by_category,
    get_new_releases,
    get_featured_playlists,
    recommended_for_you,
    BROWSE_CATEGORIES,
)

router = APIRouter(prefix="/browse", tags=["Browse"])


def _flatten_browse_items(items, kind):
    """Flatten raw search results into simple dicts for the browse/all endpoint."""
    if not items:
        return []
    result = []
    for item in items:
        if kind == 'playlist':
            result.append({
                "id": item.get("id", ""),
                "name": item.get("name", ""),
                "image_url": item.get("image_url", ""),
                "owner": item.get("owner", ""),
                "url": item.get("url", ""),
                "tracks_count": item.get("tracks_count", 0),
                "type": "playlist",
            })
        elif kind == 'album':
            result.append({
                "id": item.get("id", ""),
                "name": item.get("name", ""),
                "artists": item.get("artists", ""),
                "image_url": item.get("image_url", ""),
                "url": item.get("url", ""),
                "type": "album",
            })
        elif kind == 'track':
            result.append({
                "id": item.get("id", ""),
                "name": item.get("name", ""),
                "artists": item.get("artists", ""),
                "album_image_url": item.get("album_image_url", ""),
                "url": item.get("url", ""),
                "album": item.get("album", ""),
                "duration_ms": item.get("duration_ms", 0),
                "type": "track",
            })
    return result


def _fetch_trending():
    """Helper for browse/all to fetch trending tracks."""
    return search_spotify(q="top hits", search_type="track", limit=12, market="US")


@router.get("/all")
async def browse_all():
    """Return all browse data in a single response — categories + featured + new releases + trending.
    
    Used by the frontend to preload the entire Browse page instantly on load,
    instead of making 4+ sequential API calls.
    """
    import asyncio
    
    # Fetch all sections in parallel
    async def _safe_fetch(fn, *args, **kwargs):
        try:
            result = await asyncio.to_thread(fn, *args, **kwargs)
            return result
        except Exception:
            return None
    
    featured_raw, new_releases_raw, trending_raw = await asyncio.gather(
        _safe_fetch(get_featured_playlists, 12),
        _safe_fetch(get_new_releases, 12),
        _safe_fetch(_fetch_trending),
    )
    
    featured_items = []
    if featured_raw:
        playlists = featured_raw.get("playlists", {}).get("items", []) if isinstance(featured_raw, dict) else []
        featured_items = _flatten_browse_items(playlists, 'playlist')
    
    new_release_items = []
    if new_releases_raw:
        albums = new_releases_raw.get("albums", {}).get("items", []) if isinstance(new_releases_raw, dict) else []
        new_release_items = _flatten_browse_items(albums, 'album')
    
    trending_items = []
    if trending_raw:
        tracks = trending_raw.get("tracks", {}).get("items", []) if isinstance(trending_raw, dict) else []
        trending_items = _flatten_browse_items(tracks, 'track')
    
    return {
        "categories": BROWSE_CATEGORIES,
        "featured": featured_items[:12],
        "newReleases": new_release_items[:12],
        "trending": trending_items[:12],
    }


@router.get("/categories")
async def categories():
    """Return all available browse categories (genres, moods, scenes)."""
    return {"categories": BROWSE_CATEGORIES}


@router.get("/category/{category_id}", response_model=SearchResults)
async def category_detail(
    category_id: str,
    limit: int = Query(20, ge=1, le=50),
):
    """Get playlists and tracks for a browse category (genre/mood)."""
    try:
        raw = browse_by_category(category_id, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Browse API error: {e}")

    results = SearchResults(query=category_id)

    if "playlists" in raw:
        for pl in raw["playlists"].get("items", []):
            results.playlists.append(
                Playlist(
                    name=pl.get("name", ""),
                    id=pl.get("id", ""),
                    description=pl.get("description", ""),
                    image_url=pl.get("image_url", ""),
                    url=pl.get("url", ""),
                    tracks_count=pl.get("tracks_count", 0),
                    owner=pl.get("owner", ""),
                )
            )

    if "tracks" in raw:
        for t in raw["tracks"].get("items", []):
            results.tracks.append(
                Track(
                    name=t.get("name", ""),
                    id=t.get("id", ""),
                    artists=t.get("artists", ""),
                    album=t.get("album", ""),
                    album_image_url=t.get("album_image_url", ""),
                    duration_ms=t.get("duration_ms", 0),
                    preview_url=t.get("preview_url"),
                    url=t.get("url", ""),
                )
            )

    return results


@router.get("/new-releases", response_model=SearchResults)
async def new_releases(
    limit: int = Query(20, ge=1, le=50),
):
    """Get new album releases."""
    try:
        raw = get_new_releases(limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"New releases API error: {e}")

    results = SearchResults(query="new-releases")

    if "albums" in raw:
        for a in raw["albums"].get("items", []):
            results.albums.append(
                Album(
                    name=a.get("name", ""),
                    id=a.get("id", ""),
                    artists=a.get("artists", ""),
                    release_date=a.get("release_date", ""),
                    total_tracks=a.get("total_tracks", 0),
                    image_url=a.get("image_url", ""),
                    url=a.get("url", ""),
                )
            )

    if "tracks" in raw:
        for t in raw["tracks"].get("items", []):
            results.tracks.append(
                Track(
                    name=t.get("name", ""),
                    id=t.get("id", ""),
                    artists=t.get("artists", ""),
                    album=t.get("album", ""),
                    album_image_url=t.get("album_image_url", ""),
                    duration_ms=t.get("duration_ms", 0),
                    preview_url=t.get("preview_url"),
                    url=t.get("url", ""),
                )
            )

    return results


@router.get("/featured", response_model=SearchResults)
async def featured(
    limit: int = Query(20, ge=1, le=50),
):
    """Get featured/curated playlists."""
    try:
        raw = get_featured_playlists(limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Featured API error: {e}")

    results = SearchResults(query="featured")

    if "playlists" in raw:
        for pl in raw["playlists"].get("items", []):
            results.playlists.append(
                Playlist(
                    name=pl.get("name", ""),
                    id=pl.get("id", ""),
                    description=pl.get("description", ""),
                    image_url=pl.get("image_url", ""),
                    url=pl.get("url", ""),
                    tracks_count=pl.get("tracks_count", 0),
                    owner=pl.get("owner", ""),
                )
            )

    if "tracks" in raw:
        for t in raw["tracks"].get("items", []):
            results.tracks.append(
                Track(
                    name=t.get("name", ""),
                    id=t.get("id", ""),
                    artists=t.get("artists", ""),
                    album=t.get("album", ""),
                    album_image_url=t.get("album_image_url", ""),
                    duration_ms=t.get("duration_ms", 0),
                    preview_url=t.get("preview_url"),
                    url=t.get("url", ""),
                )
            )

    return results


@router.get("/personalized")
async def personalized(
    preferred_categories: list[str] = Query([], alias="cats"),
    limit: int = Query(12, ge=1, le=30),
):
    """Get personalized recommendations based on user's preferred categories."""
    try:
        raw = recommended_for_you(preferred_categories, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Personalized API error: {e}")

    results = SearchResults(query="personalized")

    if "playlists" in raw:
        for pl in raw["playlists"].get("items", []):
            results.playlists.append(
                Playlist(
                    name=pl.get("name", ""),
                    id=pl.get("id", ""),
                    description=pl.get("description", ""),
                    image_url=pl.get("image_url", ""),
                    url=pl.get("url", ""),
                    tracks_count=pl.get("tracks_count", 0),
                    owner=pl.get("owner", ""),
                )
            )

    if "tracks" in raw:
        for t in raw["tracks"].get("items", []):
            results.tracks.append(
                Track(
                    name=t.get("name", ""),
                    id=t.get("id", ""),
                    artists=t.get("artists", ""),
                    album=t.get("album", ""),
                    album_image_url=t.get("album_image_url", ""),
                    duration_ms=t.get("duration_ms", 0),
                    preview_url=t.get("preview_url"),
                    url=t.get("url", ""),
                )
            )

    return results


@router.get("/trending", response_model=SearchResults)
async def trending(
    limit: int = Query(20, ge=1, le=50),
):
    """Get trending/popular tracks."""
    try:
        raw = search_spotify(
            q="top hits", search_type="track", limit=limit, market="US"
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Trending API error: {e}")

    results = SearchResults(query="trending")

    if "tracks" in raw:
        for t in raw["tracks"].get("items", []):
            results.tracks.append(
                Track(
                    name=t.get("name", ""),
                    id=t.get("id", ""),
                    artists=t.get("artists", ""),
                    album=t.get("album", ""),
                    album_image_url=t.get("album_image_url", ""),
                    duration_ms=t.get("duration_ms", 0),
                    preview_url=t.get("preview_url"),
                    url=t.get("url", ""),
                )
            )

    return results
