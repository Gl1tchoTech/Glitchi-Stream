import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "Spotify SpotiFLAC API"
    DOWNLOAD_DIR: str = os.path.join(os.getcwd(), "downloads")
    CLEANUP_AGE_HOURS: int = 24  # auto-delete files older than this
    ADMIN_KEY: str = "glitchi-admin-2024"  # dev mode activation key
    DEFAULT_DOWNLOADER: str = "spotiflac"  # spotiflac | ytdlp | spotdl

    class Config:
        env_file = ".env"


settings = Settings()
os.makedirs(settings.DOWNLOAD_DIR, exist_ok=True)
