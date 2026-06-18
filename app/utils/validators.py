import re

SPOTIFY_TRACK_RE = re.compile(
    r"https?://open\.spotify\.com/(intl-\w+/)?track/[A-Za-z0-9]+"
)
SPOTIFY_ALBUM_RE = re.compile(
    r"https?://open\.spotify\.com/(intl-\w+/)?album/[A-Za-z0-9]+"
)
SPOTIFY_PLAYLIST_RE = re.compile(
    r"https?://open\.spotify\.com/(intl-\w+/)?playlist/[A-Za-z0-9]+"
)
SPOTIFY_ARTIST_RE = re.compile(
    r"https?://open\.spotify\.com/(intl-\w+/)?artist/[A-Za-z0-9]+"
)


def is_spotify_url(url: str) -> bool:
    return bool(
        SPOTIFY_TRACK_RE.match(url)
        or SPOTIFY_ALBUM_RE.match(url)
        or SPOTIFY_PLAYLIST_RE.match(url)
        or SPOTIFY_ARTIST_RE.match(url)
    )
