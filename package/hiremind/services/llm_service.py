"""LLM 服务：根据环境变量返回 LangChain Chat 模型实例."""

import os
from typing import Optional

from langchain_core.language_models.chat_models import BaseChatModel


def get_llm(
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    temperature: float = 0.4,
) -> BaseChatModel:
    """构造 LLM 实例.

    优先级：
    1. 传入参数
    2. 环境变量（OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_BASE_URL / MODEL_NAME）
    3. 默认使用 qwen3.7-plus（如未配置会报错）

    Args:
        model: 模型名，如 qwen3.7-plus、claude-3-5-sonnet-20241022
        api_key: API Key
        base_url: 仅对 OpenAI 兼容服务有效
        temperature: 生成温度

    Returns:
        LangChain Chat 模型实例
    """
    resolved_model = model or os.getenv("MODEL_NAME", "qwen3.7-plus")
    resolved_key = api_key or os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    resolved_base_url = base_url or os.getenv("OPENAI_BASE_URL")

    if resolved_model.startswith("claude"):
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError as exc:
            raise ImportError("使用 Anthropic 模型需要安装 langchain-anthropic") from exc
        return ChatAnthropic(
            model=resolved_model,
            api_key=resolved_key,
            temperature=temperature,
        )

    try:
        from langchain_openai import ChatOpenAI
    except ImportError as exc:
        raise ImportError("使用 OpenAI 兼容模型需要安装 langchain-openai") from exc

    kwargs = {
        "model": resolved_model,
        "api_key": resolved_key,
        "temperature": temperature,
    }
    if resolved_base_url:
        kwargs["base_url"] = resolved_base_url

    return ChatOpenAI(**kwargs)
