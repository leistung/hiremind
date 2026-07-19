"""FastAPI 配置：模型供应商、路径、CORS.

配置优先级:
1. .hiremind/model_config.json (设置页保存的持久化配置,首选)
2. 环境变量 (兜底,仅在 JSON 不存在时使用)
3. 字段默认值

不再依赖 .env 文件,所有模型配置通过设置页面管理。
"""

import json
import os
import sys
from pathlib import Path

from pydantic import BaseModel

# 项目根目录
PROJECT_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = PROJECT_ROOT / "package"

# 持久化模型配置文件:.hiremind/model_config.json
MODEL_CONFIG_FILE = PROJECT_ROOT / ".hiremind" / "model_config.json"

# 把 package 加入 sys.path
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))


def _load_persisted_config() -> dict:
    """从 .hiremind/model_config.json 加载持久化配置.

    Returns:
        配置字典,文件不存在或解析失败时返回空字典
    """
    if not MODEL_CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(MODEL_CONFIG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _persist_config(cfg: dict) -> None:
    """把配置写入 .hiremind/model_config.json."""
    MODEL_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    MODEL_CONFIG_FILE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# 启动时加载持久化配置
_persisted = _load_persisted_config()


class Settings(BaseModel):
    """应用配置."""

    # 模型
    default_provider: str = _persisted.get("provider") or "bailian"
    openai_api_key: str = _persisted.get("api_key") or os.getenv("OPENAI_API_KEY", "")
    anthropic_api_key: str = _persisted.get("api_key") or os.getenv("ANTHROPIC_API_KEY", "")
    openai_base_url: str = _persisted.get("base_url") or os.getenv("OPENAI_BASE_URL", "")
    model_name: str = _persisted.get("model") or os.getenv("MODEL_NAME", "qwen3.7-plus")

    # 工作区
    workspace_root: Path = PROJECT_ROOT

    # CORS
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    def persist(self) -> None:
        """把当前配置持久化到 model_config.json."""
        _persist_config({
            "provider": self.default_provider,
            "model": self.model_name,
            "base_url": self.openai_base_url,
            "api_key": self.openai_api_key or self.anthropic_api_key,
        })

    def apply_update(
        self,
        provider: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        """应用配置更新并同步到 os.environ + 持久化文件.

        Args:
            provider: 供应商 key, None 表示不修改
            model: 模型名, None 表示不修改
            api_key: API Key, None/空 表示不修改
            base_url: Base URL, None 表示不修改
        """
        if provider is not None:
            self.default_provider = provider
        if model:
            self.model_name = model
            os.environ["MODEL_NAME"] = model
        if api_key:
            self.openai_api_key = api_key
            self.anthropic_api_key = api_key
            os.environ["OPENAI_API_KEY"] = api_key
            os.environ["ANTHROPIC_API_KEY"] = api_key
        if base_url is not None:
            self.openai_base_url = base_url
            os.environ["OPENAI_BASE_URL"] = base_url
        # 持久化到磁盘
        self.persist()


settings = Settings()

# 启动时同步持久化的配置到 os.environ,让 llm_service.get_llm() 能读到
if settings.openai_api_key:
    os.environ["OPENAI_API_KEY"] = settings.openai_api_key
if settings.anthropic_api_key:
    os.environ["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
if settings.openai_base_url:
    os.environ["OPENAI_BASE_URL"] = settings.openai_base_url
if settings.model_name:
    os.environ["MODEL_NAME"] = settings.model_name
