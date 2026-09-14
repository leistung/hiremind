"""Compatibility adapter: reuse the existing engine with account-scoped stores.

Installed only in the new backend process; the standalone legacy service is not
modified. Background tasks retain the user-specific workspace captured at start.
"""
from contextvars import ContextVar
from functools import wraps
from threading import RLock
from . import workspace_repository as repository

user_context: ContextVar[int] = ContextVar("workspace_user")
agents: dict[int, object] = {}


def install():
    import json
    from hiremind import HireMindAgent, HireMindWorkspace, AnalysisStore, AskStore
    from hiremind.store import ResumeStore, PositionStore, InterviewStore
    from hiremind.services.llm_service import get_llm
    from app.server import routes, deps
    from app.server.config import settings as model_settings

    def workspace():
        user_id = user_context.get()
        repository.hydrate(user_id)
        result = HireMindWorkspace(repository.root(user_id).parent)
        result.ensure_dirs()
        return result

    def agent(model="", api_key="", base_url=""):
        user_id = user_context.get()
        if user_id not in agents:
            ws = workspace()
            agents[user_id] = HireMindAgent(
                model_client=get_llm(model=model or model_settings.model_name, api_key=api_key or model_settings.openai_api_key or model_settings.anthropic_api_key, base_url=base_url or model_settings.openai_base_url),
                workspace=ws, analysis_store=AnalysisStore(ws.analyses_dir), run_store=AskStore(ws.runs_dir),
            )
        return agents[user_id]

    def reset(model="", api_key="", base_url=""):
        agents.clear()
        return agent(model, api_key, base_url)

    for module in (deps, routes):
        module.get_workspace = workspace
        module.get_agent = agent
        module.reset_agent = reset
        module.get_resume_store = lambda: ResumeStore(workspace().resumes_dir)
        module.get_position_store = lambda: PositionStore(workspace().positions_dir)
        module.get_interview_store = lambda: InterviewStore(workspace().interviews_dir)

    # Wrap store writes, including writes made by raw background threads. Infer
    # ownership from their already-scoped path, never from a thread-local default.
    def wrap(cls, name):
        original = getattr(cls, name)
        @wraps(original)
        def persist(self, *args, **kwargs):
            user_id = repository.user_from_path(self.root)
            if user_id is None:
                return original(self, *args, **kwargs)
            with repository.locks.setdefault(user_id, RLock()):
                result = original(self, *args, **kwargs)
                repository.flush(user_id)
                return result
        setattr(cls, name, persist)

    for cls, names in ((ResumeStore, ("save", "delete")), (PositionStore, ("save", "delete")), (AnalysisStore, ("save",)), (InterviewStore, ("save", "delete")), (AskStore, ("start_run", "write_task_state", "append_trace", "write_report")), (HireMindWorkspace, ("save_report", "save_asset", "delete_report"))):
        for name in names:
            wrap(cls, name)

    # Root owns the legacy model configuration; it is not exposed via generic
    # workspace downloads. Persist global provider settings back into root's DB.
    def persist_config(self):
        from .database import SessionLocal
        from .models import User
        with SessionLocal() as db:
            owner = db.query(User).filter_by(email="root@hiremind.local").one()
            owner_id = owner.id
        repository.hydrate(owner_id)
        path = repository.root(owner_id) / "model_config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"provider": self.default_provider, "model": self.model_name, "api_key": self.openai_api_key or self.anthropic_api_key, "base_url": self.openai_base_url}), encoding="utf-8")
        repository.flush(owner_id)
    type(model_settings).persist = persist_config
    return routes.router


def load_root_model_config():
    import json, os
    from .database import SessionLocal
    from .models import User, WorkspaceFile
    from app.server.config import settings as model_settings
    with SessionLocal() as db:
        user = db.query(User).filter_by(email="root@hiremind.local").one()
        item = db.query(WorkspaceFile).filter_by(user_id=user.id, path="model_config.json").first()
        if not item:
            return
        cfg = json.loads(item.content)
    model_settings.default_provider = cfg.get("provider") or model_settings.default_provider
    model_settings.model_name = cfg.get("model") or model_settings.model_name
    model_settings.openai_api_key = cfg.get("api_key") or ""
    model_settings.openai_base_url = cfg.get("base_url") or ""
    os.environ["OPENAI_API_KEY"] = model_settings.openai_api_key
    os.environ["OPENAI_BASE_URL"] = model_settings.openai_base_url
    os.environ["MODEL_NAME"] = model_settings.model_name
