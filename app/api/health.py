import os
from fastapi import APIRouter
from app.config import settings

router = APIRouter(tags=["Health"])


@router.get("/health")
async def health_check():
    return {
        "status": "ok",
        "download_dir": settings.DOWNLOAD_DIR,
        "download_dir_exists": os.path.isdir(settings.DOWNLOAD_DIR),
    }
