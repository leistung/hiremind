"""HireMind FastAPI 后端入口."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routes import router

app = FastAPI(
    title="HireMind API",
    description="AI 模拟面试官后端 — 分析 JD/简历、生成面试题、多轮对话",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")


@app.get("/")
async def root():
    return {"name": "HireMind API", "docs": "/docs", "version": "0.2.0"}
