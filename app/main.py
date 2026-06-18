import asyncio
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.config import settings
from app.api import download, file, health, search, docs
from app.services.cleanup_service import start_cleanup_task

app = FastAPI(title=settings.PROJECT_NAME)

app.include_router(health.router)
app.include_router(download.router)
app.include_router(file.router)
app.include_router(search.router)
app.include_router(docs.router)

# Serve static files (CSS, JS, images)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(start_cleanup_task())
