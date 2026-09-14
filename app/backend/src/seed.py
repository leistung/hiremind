from sqlalchemy.orm import Session

from .models import Project

PROJECTS = [
    {"slug": "langchain-ai-langchain", "name": "LangChain", "category": "AI 应用", "summary": "构建 LLM 应用和 Agent 的通用框架。", "github_url": "https://github.com/langchain-ai/langchain", "deepwiki_url": "https://deepwiki.com/langchain-ai/langchain", "language": "Python", "stars": 110000, "loc": 438000, "loc_delta": 2860},
    {"slug": "langchain-ai-langgraph", "name": "LangGraph", "category": "AI 应用", "summary": "面向有状态、多代理工作流的编排框架。", "github_url": "https://github.com/langchain-ai/langgraph", "deepwiki_url": "https://deepwiki.com/langchain-ai/langgraph", "language": "Python", "stars": 19000, "loc": 97000, "loc_delta": 740},
    {"slug": "fastapi-fastapi", "name": "FastAPI", "category": "后端工程", "summary": "高性能 Python API 框架，类型驱动、文档原生。", "github_url": "https://github.com/fastapi/fastapi", "deepwiki_url": "https://deepwiki.com/fastapi/fastapi", "language": "Python", "stars": 87000, "loc": 157000, "loc_delta": 310},
    {"slug": "vercel-next.js", "name": "Next.js", "category": "前端工程", "summary": "React 全栈框架，覆盖渲染、路由与生产部署。", "github_url": "https://github.com/vercel/next.js", "deepwiki_url": "https://deepwiki.com/vercel/next.js", "language": "TypeScript", "stars": 131000, "loc": 1320000, "loc_delta": 4210},
    {"slug": "pallets-flask", "name": "Flask", "category": "后端工程", "summary": "简洁而成熟的 Python Web 微框架。", "github_url": "https://github.com/pallets/flask", "deepwiki_url": "https://deepwiki.com/pallets/flask", "language": "Python", "stars": 69000, "loc": 87000, "loc_delta": 82},
]


def seed_projects(db: Session) -> None:
    if db.query(Project).count():
        return
    db.add_all(Project(**project) for project in PROJECTS)
    db.commit()
