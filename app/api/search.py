from fastapi import APIRouter, HTTPException, Query
from app.models.responses import (
    SearchResults,
    Track,
    Album,
    Artist,
    Playlist,
)
from app.services.spotify_search_service import search_spotify

router = APIRouter(prefix="/search", tags=["Search"])


@router.get("/", response_model=SearchResults)
async def search(
    q: str = Query(..., description="Search query", min_length=1),
    type: str = Query("track,album,artist,playlist", description="Types: track,album,artist,playlist"),
    limit: int = Query(20, ge=1, le=50),
    market: str = Query("US", min_length=2, max_length=2),
):
    try:
        raw = search_spotify(q=q, search_type=type, limit=limit, market=market)
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Search API error: {e}"
        )

    results = SearchResults(query=q)

    if "tracks" in raw:
        for t in raw["tracks"]["items"]:
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

    if "albums" in raw:
        for a in raw["albums"]["items"]:
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

    if "artists" in raw:
        for ar in raw["artists"]["items"]:
            results.artists.append(
                Artist(
                    name=ar.get("name", ""),
                    id=ar.get("id", ""),
                    genres=ar.get("genres", ""),
                    image_url=ar.get("image_url", ""),
                    url=ar.get("url", ""),
                )
            )

    if "playlists" in raw:
        for pl in raw["playlists"]["items"]:
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

    return results
