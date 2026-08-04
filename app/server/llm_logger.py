"""LLM 交互日志:记录所有与大模型的 HTTP 交互内容.

按天记录到 logs/llm-interaction-YYYY-MM-DD.log,文件名按天自动切换。
通过 LangChain 的 BaseCallbackHandler 钩子捕获:
- on_chat_model_start: 发送给大模型的消息(prompt)
- on_llm_end: 大模型返回的响应(completion)与 token 用量
- on_llm_error: 调用异常

每条日志包含:时间戳、模型名、请求消息(逐条格式化)、响应内容、token 用量、耗时。
请求/响应超过 8KB 截断,防止日志膨胀。
"""

import json
import logging
import threading
import time
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import BaseMessage
from langchain_core.outputs import LLMResult

# 日志目录(app/server/logs/)
LOG_DIR = Path(__file__).resolve().parent / "logs"

# 请求/响应单条消息最大记录长度(字符)
MAX_CONTENT_LOG = 8192

# 日志调用序号(线程安全自增)
_call_counter = 0
_call_counter_lock = threading.Lock()


def _next_call_id() -> int:
    global _call_counter
    with _call_counter_lock:
        _call_counter += 1
        return _call_counter


class LLMDailyFileHandler(logging.Handler):
    """按天切换文件的日志 handler,文件名 llm-interaction-YYYY-MM-DD.log."""

    def __init__(self, log_dir: Path):
        super().__init__()
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._current_date: Optional[str] = None
        self._fp = None
        self._lock = threading.Lock()

    def _ensure_file(self) -> None:
        today = date.today().isoformat()
        if today == self._current_date and self._fp:
            return
        with self._lock:
            if today == self._current_date and self._fp:
                return
            if self._fp:
                try:
                    self._fp.close()
                except Exception:
                    pass
            self._current_date = today
            filepath = self.log_dir / f"llm-interaction-{today}.log"
            self._fp = open(filepath, "a", encoding="utf-8")

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._ensure_file()
            msg = self.format(record)
            with self._lock:
                if self._fp:
                    self._fp.write(msg + "\n")
                    self._fp.flush()
        except Exception:
            self.handleError(record)

    def close(self) -> None:
        with self._lock:
            if self._fp:
                try:
                    self._fp.close()
                except Exception:
                    pass
                self._fp = None
        super().close()


# ── logger 单例 ──

_logger: Optional[logging.Logger] = None


def get_llm_logger() -> logging.Logger:
    """获取 LLM 交互日志 logger(单例,首次调用时初始化 handler)."""
    global _logger
    if _logger is not None:
        return _logger
    _logger = logging.getLogger("hiremind.llm")
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    handler = LLMDailyFileHandler(LOG_DIR)
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(handler)
    return _logger


# ── 辅助函数 ──


def _truncate(text: str, limit: int = MAX_CONTENT_LOG) -> str:
    """截断过长的文本,附带总长度提示."""
    if len(text) <= limit:
        return text
    return text[:limit] + f"...[truncated, total {len(text)} chars]"


def _format_message(msg: BaseMessage) -> str:
    """将单条 LangChain 消息格式化为可读文本."""
    role = msg.type.upper()  # system / human / ai / function / tool 等
    content = msg.content
    if isinstance(content, list):
        # 多模态消息(content 为列表),序列化为 JSON
        try:
            content = json.dumps(content, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            content = str(content)
    else:
        content = str(content)
    return f"  [{role}]:\n{_truncate(content)}"


def _format_messages(messages: List[BaseMessage]) -> str:
    """格式化消息列表."""
    return "\n".join(_format_message(m) for m in messages)


def _extract_model_name(serialized: Optional[Dict[str, Any]]) -> str:
    """从 serialized 字典提取模型名."""
    if not serialized:
        return "unknown"
    # langchain_openai 的 serialized 结构:{"id": [...], "kwargs": {"model": "..."}}
    kwargs = serialized.get("kwargs", {})
    return kwargs.get("model") or kwargs.get("model_name") or "unknown"


def _extract_response_content(response: LLMResult) -> str:
    """从 LLMResult 提取响应文本."""
    if not response.generations:
        return "(empty)"
    parts: List[str] = []
    for gen_list in response.generations:
        for gen in gen_list:
            # ChatGeneration 有 message 属性
            msg = getattr(gen, "message", None)
            if msg is not None:
                content = msg.content
                if isinstance(content, list):
                    try:
                        content = json.dumps(content, ensure_ascii=False, indent=2)
                    except (TypeError, ValueError):
                        content = str(content)
                else:
                    content = str(content)
                parts.append(_truncate(content))
            else:
                text = getattr(gen, "text", "")
                parts.append(_truncate(str(text)))
    return "\n".join(parts) if parts else "(empty)"


def _extract_token_usage(response: LLMResult) -> str:
    """从 LLMResult.llm_output 提取 token 用量."""
    if not response.llm_output:
        return ""
    usage = response.llm_output
    # OpenAI 格式:{"token_usage": {"prompt_tokens": N, "completion_tokens": N, "total_tokens": N}}
    # Anthropic 格式:{"usage": {"input_tokens": N, "output_tokens": N}}
    token_usage = usage.get("token_usage") or usage.get("usage") or {}
    if not token_usage:
        return ""
    prompt_t = token_usage.get("prompt_tokens") or token_usage.get("input_tokens") or 0
    completion_t = token_usage.get("completion_tokens") or token_usage.get("output_tokens") or 0
    total_t = token_usage.get("total_tokens") or (prompt_t + completion_t)
    return f"  tokens: prompt={prompt_t}, completion={completion_t}, total={total_t}"


# ── LangChain Callback Handler ──


class LLMLoggingCallback(BaseCallbackHandler):
    """LangChain 回调:记录所有 LLM 调用的请求与响应.

    通过 on_chat_model_start 记录开始时间和请求消息,
    通过 on_llm_end 记录响应内容和 token 用量,
    合并为一条完整的日志条目。
    """

    def __init__(self):
        # invocation_id → (start_time, call_id, model_name, messages_str)
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ── chat 模型(ChatOpenAI / ChatAnthropic 走这里)──

    def on_chat_model_start(
        self,
        serialized: Dict[str, Any],
        messages: List[List[BaseMessage]],
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> Any:
        model_name = _extract_model_name(serialized)
        # messages 是 List[List[BaseMessage]],取第一组(通常只有一组)
        msg_list = messages[0] if messages else []
        call_id = _next_call_id()
        with self._lock:
            self._pending[str(run_id)] = {
                "start_time": time.perf_counter(),
                "call_id": call_id,
                "model_name": model_name,
                "messages_str": _format_messages(msg_list),
                "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            }

    # ── 非 chat 模型(普通 LLM 走这里,兼容)──

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> Any:
        model_name = _extract_model_name(serialized)
        prompts_str = "\n".join(
            f"  [prompt {i + 1}]:\n{_truncate(p)}" for i, p in enumerate(prompts)
        )
        call_id = _next_call_id()
        with self._lock:
            self._pending[str(run_id)] = {
                "start_time": time.perf_counter(),
                "call_id": call_id,
                "model_name": model_name,
                "messages_str": prompts_str or "  (empty)",
                "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            }

    # ── LLM 调用结束 ──

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> Any:
        key = str(run_id)
        with self._lock:
            info = self._pending.pop(key, None)
        if not info:
            return

        duration_ms = (time.perf_counter() - info["start_time"]) * 1000
        resp_content = _extract_response_content(response)
        token_info = _extract_token_usage(response)

        logger = get_llm_logger()
        logger.info(
            f"\n{'=' * 80}\n"
            f"[{info['ts']}] LLM Call #{info['call_id']}\n"
            f"  model: {info['model_name']}\n"
            f"  ── Request Messages ──\n"
            f"{info['messages_str']}\n"
            f"  ── Response ──\n"
            f"  {_truncate(resp_content)}\n"
            f"{token_info}\n"
            f"  duration: {duration_ms:.1f}ms"
        )

    # ── LLM 调用异常 ──

    def on_llm_error(
        self,
        error: Union[Exception, KeyboardInterrupt],
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> Any:
        key = str(run_id)
        with self._lock:
            info = self._pending.pop(key, None)
        if not info:
            return

        duration_ms = (time.perf_counter() - info["start_time"]) * 1000
        error_msg = str(error)
        # 截断超长错误信息
        if len(error_msg) > MAX_CONTENT_LOG:
            error_msg = error_msg[:MAX_CONTENT_LOG] + f"...[truncated, total {len(error_msg)} chars]"

        logger = get_llm_logger()
        logger.info(
            f"\n{'=' * 80}\n"
            f"[{info['ts']}] LLM Call #{info['call_id']} [ERROR]\n"
            f"  model: {info['model_name']}\n"
            f"  ── Request Messages ──\n"
            f"{info['messages_str']}\n"
            f"  ── Error ──\n"
            f"  {error_msg}\n"
            f"  duration: {duration_ms:.1f}ms"
        )


# ── 全局 callback 单例 ──

_callback: Optional[LLMLoggingCallback] = None


def get_llm_callback() -> LLMLoggingCallback:
    """获取 LLM 日志 callback 单例."""
    global _callback
    if _callback is None:
        _callback = LLMLoggingCallback()
    return _callback


def get_llm_callbacks() -> List[BaseCallbackHandler]:
    """返回 callback 列表,供 LLM 实例的 callbacks 参数使用."""
    return [get_llm_callback()]
