"""Backward-compat wrapper — delegates to :mod:`app.services.ytdlp_streamer`.

Kept for any code that still imports from here; new code should import
from ``ytdlp_streamer`` directly.
"""

from app.services.ytdlp_streamer import (   # noqa: F401  — re-export
    resolve_stream as search_youtube_audio,
    clear_cache as clear_stream_cache,
)
