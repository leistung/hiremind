"""测试 LLM 配置是否能正常调用对话接口."""

import json
import os
import sys
from pathlib import Path

import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# 从 .hiremind/model_config.json 加载模型配置
_config_file = PROJECT_ROOT / ".hiremind" / "model_config.json"
if _config_file.exists():
    try:
        _cfg = json.loads(_config_file.read_text(encoding="utf-8"))
        if _cfg.get("api_key"):
            os.environ["OPENAI_API_KEY"] = _cfg["api_key"]
            os.environ["ANTHROPIC_API_KEY"] = _cfg["api_key"]
        if _cfg.get("base_url"):
            os.environ["OPENAI_BASE_URL"] = _cfg["base_url"]
        if _cfg.get("model"):
            os.environ["MODEL_NAME"] = _cfg["model"]
    except (json.JSONDecodeError, OSError):
        pass

if str(PROJECT_ROOT / "package") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "package"))

from hiremind.services import get_llm
from langchain_core.messages import HumanMessage, SystemMessage


def _mask_key(key: str) -> str:
    if len(key) <= 12:
        return "***"
    return f"{key[:6]}...{key[-6:]}"


def test_models_endpoint(api_key: str, base_url: str) -> None:
    """测试 /v1/models 列表接口."""
    print("\n[1] 测试模型列表接口 (/v1/models)")
    url = base_url.rstrip("/") + "/models"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=15,
        )
        print(f"  HTTP 状态码: {resp.status_code}")
        if resp.status_code == 200:
            models = [m.get("id") for m in resp.json().get("data", [])]
            print(f"  可用模型数: {len(models)}")
            for m in models[:10]:
                print(f"    - {m}")
            if len(models) > 10:
                print(f"    ... 还有 {len(models) - 10} 个")
        else:
            print(f"  响应: {resp.text[:300]}")
    except Exception as exc:
        print(f"  请求异常: {exc}")


def test_chat_endpoint(api_key: str, base_url: str, model_name: str) -> None:
    """直接用 requests 测试 /v1/chat/completions."""
    print("\n[2] 测试对话接口 (/v1/chat/completions)")
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": "你是一个有帮助的助手。"},
            {"role": "user", "content": "你好，请用一句话介绍自己。"},
        ],
        "max_tokens": 100,
    }
    try:
        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )
        print(f"  HTTP 状态码: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            content = data["choices"][0]["message"].get("content", "")
            print(f"  模型回复: {content[:200]}")
        else:
            print(f"  响应: {resp.text[:500]}")
    except Exception as exc:
        print(f"  请求异常: {exc}")


def test_langchain_path(model_name: str) -> None:
    """测试 HireMind 内部使用的 LangChain 调用路径."""
    print("\n[3] 测试 HireMind 内部调用路径 (LangChain)")
    print(f"  环境 MODEL_NAME: {model_name}")
    try:
        llm = get_llm()
        messages = [
            SystemMessage(content="你是一个有帮助的助手。"),
            HumanMessage(content="你好，请用一句话介绍自己。"),
        ]
        response = llm.invoke(messages)
        print(f"  模型回复: {response.content[:200]}")
    except Exception as exc:
        print(f"  调用异常: {type(exc).__name__}: {exc}")


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY", "")
    base_url = os.getenv("OPENAI_BASE_URL", "")
    model_name = os.getenv("MODEL_NAME", "qwen3.7-plus")

    print("当前配置:")
    print(f"  Base URL: {base_url or '未设置'}")
    print(f"  API Key:  {_mask_key(api_key)}")
    print(f"  Model:    {model_name}")

    if not api_key or not base_url:
        print("\n错误: OPENAI_API_KEY 或 OPENAI_BASE_URL 未设置，请到设置页面配置模型,或检查 .hiremind/model_config.json 文件。")
        sys.exit(1)

    test_models_endpoint(api_key, base_url)
    test_chat_endpoint(api_key, base_url, model_name)
    test_langchain_path(model_name)


if __name__ == "__main__":
    main()
