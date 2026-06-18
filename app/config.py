import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "Spotify SpotiFLAC API"
    DOWNLOAD_DIR: str = os.path.join(os.getcwd(), "downloads")
    CLEANUP_AGE_HOURS: int = 24  # auto-delete files older than this

    class Config:
        env_file = ".env"


settings = Settings()
os.makedirs(settings.DOWNLOAD_DIR, exist_ok=True)
