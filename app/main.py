import asyncio
from fastapi import FastAPI
from app.config import settings
from app.api import download, file, health, search, docs
from app.services.cleanup_service import start_cleanup_task

app = FastAPI(title=settings.PROJECT_NAME)

app.include_router(health.router)
app.include_router(download.router)
app.include_router(file.router)
app.include_router(search.router)
app.include_router(docs.router)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(start_cleanup_task())
