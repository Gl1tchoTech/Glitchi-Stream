import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "Glitchi-Stream"
    DOWNLOAD_DIR: str = os.path.join(os.path.expanduser("~"), "glitchi-downloads")
    CLEANUP_AGE_HOURS: int = 24  # auto-delete files older than this
    ADMIN_KEY: str = "glitchi-admin-2024"  # dev mode activation key
    DEFAULT_DOWNLOADER: str = "ytdlp"  # ytdlp | spotdl
    # Audio sources for the yt-dlp engine, tried in order. YouTube blocks
    # datacenter IPs (Render included) with a bot check, so SoundCloud is the
    # fallback that keeps downloads working on the server.
    AUDIO_SOURCES: str = "youtube,soundcloud"
    # Optional Netscape cookies.txt to authenticate YouTube requests.
    YTDLP_COOKIES_FILE: str = ""
    YTDLP_COOKIES: str = ""  # raw cookies.txt contents (env var)

    class Config:
        env_file = ".env"


settings = Settings()
os.makedirs(settings.DOWNLOAD_DIR, exist_ok=True)
