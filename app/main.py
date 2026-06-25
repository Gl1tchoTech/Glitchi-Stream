import asyncio
import sys

# Ensure ProactorEventLoop on Windows — required for asyncio.create_subprocess_exec
# (yt-dlp streaming and SpotiFLAC/SpotDL subprocess downloads)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.config import settings
from app.api import download, file, health, search, docs, playlists, browse
from app.services.cleanup_service import start_cleanup_task
from app.services.download_task_manager import task_manager
from app.utils.logger import logger

app = FastAPI(title=settings.PROJECT_NAME)

app.include_router(health.router)
app.include_router(download.router)
app.include_router(file.router)
app.include_router(search.router)
app.include_router(docs.router)
app.include_router(playlists.router)

app.include_router(browse.router)

# Serve static files (CSS, JS, images)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/favicon.ico")
async def favicon():
    """Return a minimal SVG favicon to prevent 404s."""
    from fastapi.responses import Response
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<circle cx="16" cy="16" r="14" fill="#1DB954"/>'
        '<path d="M22.5 14.5l-9 5.2v-10.4l9 5.2z" fill="#fff"/>'
        '</svg>'
    )
    return Response(content=svg, media_type="image/svg+xml")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(start_cleanup_task())
    asyncio.create_task(task_manager.start_cleanup_loop())
    if sys.platform == "win32":
        logger.info(f"Windows event loop: {type(asyncio.get_event_loop_policy()).__name__}")
