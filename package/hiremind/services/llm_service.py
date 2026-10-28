"""LLM 服务：根据环境变量返回 LangChain Chat 模型实例."""

import os
from typing import Optional

from langchain_core.language_models.chat_models import BaseChatModel


def _get_llm_callbacks():
    """获取 LLM 日志 callback 列表.

    延迟导入避免循环依赖(llm_logger 位于 app/server,而本模块位于 package/)。
    仅在后端服务环境下启用;测试或独立使用 package 时若导入失败则不附加 callback。
    """
    try:
        from app.server.llm_logger import get_llm_callbacks
        return get_llm_callbacks()
    except Exception:
        return None


def get_llm(
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    temperature: float = 0.4,
    max_tokens: Optional[int] = 16384,
) -> BaseChatModel:
    """构造 LLM 实例.

    优先级：
    1. 传入参数
    2. 环境变量（OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_BASE_URL / MODEL_NAME）
    3. 默认使用 qwen3.7-plus（如未配置会报错）

    分派规则:
    - model 以 "claude" 开头 → langchain-anthropic 的 ChatAnthropic;
    - 其他(含 qwen/glm/deepseek 等) → OpenAI 兼容协议 ChatOpenAI。

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
    callbacks = _get_llm_callbacks()

    if resolved_model.startswith("claude"):
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError as exc:
            raise ImportError("使用 Anthropic 模型需要安装 langchain-anthropic") from exc
        return ChatAnthropic(
            model=resolved_model,
            api_key=resolved_key,
            temperature=temperature,
            callbacks=callbacks,
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
    if callbacks:
        kwargs["callbacks"] = callbacks

    extra_body: dict = {}

    # 显式输出上限:不设的话部分兼容服务端默认给到 65536,模型输出失控
    # (如工具参数重复生成)时要烧满上限才截断,一次调用能拖 20 分钟。
    # 传参方式:langchain-openai 1.x 会把 max_tokens 字段序列化成
    # max_completion_tokens,而 bigmodel 等兼容端点只认 max_tokens 原名
    # (实测 max_completion_tokens 被忽略、max_tokens 生效),所以兼容
    # 服务统一走 extra_body 顶层合并;无 base_url(官方 OpenAI)才用标准字段。
    if max_tokens:
        if resolved_base_url:
            extra_body["max_tokens"] = max_tokens
        else:
            kwargs["max_tokens"] = max_tokens

    # 关闭思维链,避免 reasoning tokens 挤爆输出上限、拖慢结构化输出。
    # 各家参数不同,按 base_url 分派(传错参数要么被忽略、要么直接报错):
    # - dashscope(阿里百炼): enable_thinking=False
    # - bigmodel(智谱): thinking.type=disabled(官方参数,实测
    #   enable_thinking 对智谱的工具调用场景不生效,模型照样思考)
    # 注:glm-5.3 / glm-4.7 等强制思考模型不支持关闭,传 disabled 会报错,
    # 需排除;这些模型只能靠 reasoning_effort 调低,这里不做特殊处理。
    if resolved_base_url and "dashscope" in resolved_base_url:
        extra_body["enable_thinking"] = False
    elif resolved_base_url and "bigmodel" in resolved_base_url and not any(
        s in resolved_model for s in ("5.3", "4.7")
    ):
        extra_body["thinking"] = {"type": "disabled"}

    if extra_body:
        kwargs["extra_body"] = extra_body

    return ChatOpenAI(**kwargs)


def get_structured_llm(schema, **llm_kwargs):
    """返回绑定了结构化输出 schema 的 LLM.

    统一走 function_calling(OpenAI tools)而不是 langchain-openai>=1.x
    默认的 json_schema:默认 method="json_schema" 会发送
    response_format={"type": "json_schema"},而 OpenAI 兼容第三方端点
    (bigmodel/dashscope/本地部署等)普遍不支持该参数,收到后模型不受约束,
    直接输出纯文本或 markdown 代码块包裹的 JSON,Pydantic 校验必然失败
    (Invalid JSON: expected value at line 1 column 1)。
    function_calling 走 tools 参数,是兼容端点支持最广、最稳的方式
    (实测 bigmodel glm-5.2:json_schema 全量失败,function_calling 正常)。

    Args:
        schema: Pydantic 模型类(结构化输出的目标 schema)。
        **llm_kwargs: 透传给 get_llm 的参数(model/api_key 等)。

    Returns:
        绑定 schema 的 Runnable,invoke 后返回 Pydantic 实例。
    """
    llm = get_llm(**llm_kwargs)
    return llm.with_structured_output(schema, method="function_calling")
