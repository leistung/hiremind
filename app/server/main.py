"""HireMind FastAPI 后端入口."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routes import router

# OpenAPI 分组定义:控制 /docs 中各分组的展示顺序与描述
openapi_tags = [
    {"name": "Health", "description": "健康检查,确认服务是否在线"},
    {"name": "Models", "description": "LLM 模型配置与连接测试"},
    {"name": "Assets", "description": "上传资源(图片等)的访问服务"},
    {"name": "Positions", "description": "职位库管理:CRUD"},
    {"name": "Resumes", "description": "简历库管理:CRUD、上传解析、导出、头像"},
    {"name": "Documents", "description": "PDF / Word 文档解析为纯文本"},
    {"name": "Analysis", "description": "面试分析:执行分析与历史报告查询"},
    {"name": "Interview", "description": "模拟面试:启动、答题、出题、结束与报告"},
    {"name": "Export", "description": "分析报告导出为 Word / PDF 并下载"},
]

app = FastAPI(
    title="HireMind API",
    description="AI 模拟面试官后端 — 分析 JD/简历、生成面试题、多轮对话",
    version="0.2.0",
    openapi_tags=openapi_tags,
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
