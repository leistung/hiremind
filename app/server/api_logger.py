"""API 请求/响应日志中间件.

按天记录所有 API 请求与响应到 logs/api-access-YYYY-MM-DD.log,
文件名按天自动切换,便于排查问题与审计。

设计要点:
- 使用纯 ASGI 中间件(非 BaseHTTPMiddleware),避免对 SSE 流式响应的缓冲
- SSE 端点直接透传,不做任何拦截,确保实时推送
- 排除健康检查/文档等无意义路径
- 请求体/响应体超过 4KB 截断,防止日志膨胀
- JSON 响应美化输出,便于人工阅读
"""

import json
import logging
import threading
import time
from datetime import date, datetime
from pathlib import Path

# 日志目录(app/server/logs/)
LOG_DIR = Path(__file__).resolve().parent / "logs"

# 不记录的路径(健康检查、文档、根路径)
EXCLUDE_PATHS = {"/api/health", "/docs", "/redoc", "/openapi.json", "/"}

# SSE 端点路径片段(流式响应,直接透传不拦截)
SSE_PATH_MARKERS = ("/stream/",)

# 请求体/响应体最大记录长度(字节)
MAX_BODY_LOG = 4096


class DailyFileHandler(logging.Handler):
    """按天切换文件的日志 handler,文件名 api-access-YYYY-MM-DD.log."""

    def __init__(self, log_dir: Path):
        super().__init__()
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._current_date: str | None = None
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
            filepath = self.log_dir / f"api-access-{today}.log"
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

_logger: logging.Logger | None = None


def get_api_logger() -> logging.Logger:
    """获取 API 日志 logger(单例,首次调用时初始化 handler)."""
    global _logger
    if _logger is not None:
        return _logger
    _logger = logging.getLogger("hiremind.api")
    _logger.setLevel(logging.INFO)
    _logger.propagate = False  # 不冒泡到 root logger,避免重复输出
    handler = DailyFileHandler(LOG_DIR)
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(handler)
    return _logger


def _is_excluded(path: str) -> bool:
    """是否为不需要记录的路径."""
    for p in EXCLUDE_PATHS:
        if path == p or path.startswith(p + "/"):
            return True
    return False


def _is_sse(path: str) -> bool:
    """是否为 SSE 流式端点."""
    return any(m in path for m in SSE_PATH_MARKERS)


def _truncate(data: str, limit: int = MAX_BODY_LOG) -> str:
    """截断过长的文本,附带总长度提示."""
    if len(data) <= limit:
        return data
    return data[:limit] + f"...[truncated, total {len(data)} chars]"


def _safe_json_parse(raw: bytes) -> str:
    """尝试解析 JSON 并美化输出,失败则返回原始文本."""
    if not raw:
        return ""
    text = raw.decode("utf-8", errors="replace")
    try:
        obj = json.loads(text)
        return json.dumps(obj, ensure_ascii=False, indent=2)
    except (json.JSONDecodeError, TypeError):
        return text


class APILoggingMiddleware:
    """纯 ASGI 中间件:记录所有 API 请求和响应.

    使用纯 ASGI 实现而非 BaseHTTPMiddleware,避免后者内部 channel
    对 SSE 流式响应造成缓冲(导致前端实时进度不更新)。

    SSE 端点(/stream/ 路径)直接透传,不做任何拦截。
    非 SSE 端点通过包装 receive/send 捕获请求体和响应体用于日志。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        # 非 HTTP 请求(如 lifespan)直接透传
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # 排除路径:直接透传
        if _is_excluded(path):
            await self.app(scope, receive, send)
            return

        # SSE 端点:直接透传,不做任何拦截(关键:避免缓冲流式响应)
        if _is_sse(path):
            await self.app(scope, receive, send)
            return

        # ── 非 SSE 端点:捕获请求体和响应体用于日志 ──

        method = scope.get("method", "")
        query_string = scope.get("query_string", b"").decode("utf-8", errors="replace")
        client = scope.get("client")
        client_ip = client[0] if client else "-"

        # 包装 receive:捕获请求体
        req_body = b""

        async def receive_wrapper():
            nonlocal req_body
            message = await receive()
            if message["type"] == "http.request":
                req_body += message.get("body", b"")
            return message

        # 包装 send:捕获响应状态和响应体
        resp_status = 0
        resp_body = b""

        async def send_wrapper(message):
            nonlocal resp_status, resp_body
            if message["type"] == "http.response.start":
                resp_status = message.get("status", 0)
            elif message["type"] == "http.response.body":
                resp_body += message.get("body", b"")
            await send(message)

        # 执行下游应用
        start = time.perf_counter()
        try:
            await self.app(scope, receive_wrapper, send_wrapper)
        except Exception:
            # 异常也记录,然后重新抛出
            duration_ms = (time.perf_counter() - start) * 1000
            logger = get_api_logger()
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            query_str = f"?{query_string}" if query_string else ""
            req_text = _truncate(_safe_json_parse(req_body)) if req_body else ""
            logger.info(
                f"\n{'=' * 80}\n"
                f"[{ts}] {method} {path}{query_str}\n"
                f"  client: {client_ip}\n"
                f"  status: ERROR  duration: {duration_ms:.1f}ms\n"
                f"  request_body:\n{req_text}\n"
                f"  response_body: [exception raised]"
            )
            raise

        duration_ms = (time.perf_counter() - start) * 1000

        # 组装并写入日志
        logger = get_api_logger()
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        query_str = f"?{query_string}" if query_string else ""

        req_text = _truncate(_safe_json_parse(req_body)) if req_body else ""
        resp_text = _truncate(_safe_json_parse(resp_body))

        logger.info(
            f"\n{'=' * 80}\n"
            f"[{ts}] {method} {path}{query_str}\n"
            f"  client: {client_ip}\n"
            f"  status: {resp_status}  duration: {duration_ms:.1f}ms\n"
            f"  request_body:\n{req_text}\n"
            f"  response_body:\n{resp_text}"
        )
