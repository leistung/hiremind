"""依赖注入：Agent 单例、LLM 构造、各类 Store."""

from functools import lru_cache
from pathlib import Path

from hiremind import HireMindAgent, HireMindWorkspace, RunStore, AnalysisStore
from hiremind.store import InterviewStore, PositionStore, ResumeStore
from hiremind.services.llm_service import get_llm as _get_llm

from .config import settings


def get_workspace() -> HireMindWorkspace:
    """获取工作区单例."""
    ws = HireMindWorkspace(settings.workspace_root)
    ws.ensure_dirs()
    return ws


def get_resume_store() -> ResumeStore:
    return ResumeStore(get_workspace().resumes_dir)


def get_position_store() -> PositionStore:
    return PositionStore(get_workspace().positions_dir)


def get_interview_store() -> InterviewStore:
    return InterviewStore(get_workspace().interviews_dir)


@lru_cache(maxsize=1)
def get_agent(
    model: str = "",
    api_key: str = "",
    base_url: str = "",
) -> HireMindAgent:
    """获取 Agent 单例."""
    ws = get_workspace()
    llm = _get_llm(
        model=model or settings.model_name,
        api_key=api_key or settings.openai_api_key or settings.anthropic_api_key,
        base_url=base_url or settings.openai_base_url,
    )
    return HireMindAgent(
        model_client=llm,
        workspace=ws,
        analysis_store=AnalysisStore(ws.analyses_dir),
        run_store=RunStore(ws.runs_dir),
    )


def reset_agent(model: str = "", api_key: str = "", base_url: str = "") -> HireMindAgent:
    """重置 Agent（配置变更时调用）."""
    get_agent.cache_clear()
    return get_agent(model, api_key, base_url)
