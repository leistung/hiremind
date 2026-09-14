from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, SessionLocal, engine
from .routes import router
from .seed import seed_projects
from .migration import bootstrap
from .preparation import router as preparation_router
from .engine_adapter import install, load_root_model_config
from .middleware import AccountBoundary
from .sessions import cache


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        bootstrap(db)
        seed_projects(db)
    load_root_model_config()
    cache.ping()
    yield


app = FastAPI(title="HireMind Account & Workspace API", version="2.0.0", lifespan=lifespan)
app.add_middleware(AccountBoundary)
app.add_middleware(CORSMiddleware, allow_origins=settings.origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(router, prefix="/api/v1")
app.include_router(preparation_router, prefix="/api/v1")
app.include_router(install(), prefix="/api/workbench")


@app.get("/health")
def health():
    from sqlalchemy import text
    with SessionLocal() as db:
        db.execute(text("SELECT 1"))
    cache.ping()
    return {"status": "ok", "service": "hiremind-backend-v2", "mysql": "ok", "redis": "ok"}
