from fastapi import APIRouter
from fastapi.openapi.docs import get_swagger_ui_html

router = APIRouter()

# FastAPI auto-serves /docs and /redoc by default.
# This router is here if you want custom documentation endpoints later.
# Leave as-is; the auto-generated Swagger UI will show all your routes.
