from fastapi import APIRouter, HTTPException, Query
from app.models.responses import (
    SearchResults,
    SpotifyTrack,
    SpotifyAlbum,
    SpotifyArtist,
)
from app.services.spotify_search_service import search_spotify

router = APIRouter(prefix="/search", tags=["Search"])


@router.get("/", response_model=SearchResults)
async def search(
    q: str = Query(..., description="Search query", min_length=1),
    type: str = Query("track,album,artist", description="Types: track,album,artist"),
    limit: int = Query(20, ge=1, le=50),
    market: str = Query("US", min_length=2, max_length=2),
):
    try:
        raw = search_spotify(q=q, search_type=type, limit=limit, market=market)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Spotify API error: {e}")

    results = SearchResults(query=q)

    if "tracks" in raw:
        for t in raw["tracks"]["items"]:
            results.tracks.append(
                SpotifyTrack(
                    name=t["name"],
                    id=t["id"],
                    uri=t["uri"],
                    artists=", ".join(a["name"] for a in t["artists"]),
                    album=t["album"]["name"],
                    album_image_url=(
                        t["album"]["images"][0]["url"]
                        if t["album"].get("images")
                        else ""
                    ),
                    duration_ms=t["duration_ms"],
                    explicit=t.get("explicit", False),
                    popularity=t.get("popularity", 0),
                    preview_url=t.get("preview_url"),
                    url=t["external_urls"].get("spotify", ""),
                )
            )

    if "albums" in raw:
        for a in raw["albums"]["items"]:
            results.albums.append(
                SpotifyAlbum(
                    name=a["name"],
                    id=a["id"],
                    uri=a["uri"],
                    artists=", ".join(ar["name"] for ar in a["artists"]),
                    release_date=a.get("release_date", ""),
                    total_tracks=a.get("total_tracks", 0),
                    image_url=a["images"][0]["url"] if a.get("images") else "",
                    url=a["external_urls"].get("spotify", ""),
                )
            )

    if "artists" in raw:
        for ar in raw["artists"]["items"]:
            results.artists.append(
                SpotifyArtist(
                    name=ar["name"],
                    id=ar["id"],
                    uri=ar["uri"],
                    genres=", ".join(ar.get("genres", [])),
                    followers=ar.get("followers", {}).get("total", 0),
                    image_url=ar["images"][0]["url"] if ar.get("images") else "",
                    url=ar["external_urls"].get("spotify", ""),
                )
            )

    return results
