"""API 请求/响应日志中间件.

按天记录所有 API 请求与响应到 logs/api-access-YYYY-MM-DD.log,
文件名按天自动切换,便于排查问题与审计。

设计要点:
- 使用自定义 DailyFileHandler,文件名直接含日期(非轮转后缀)
- 排除健康检查/文档等无意义路径
- SSE 流式端点不记录响应体(持续流,无法一次性读取)
- 请求体/响应体超过 4KB 截断,防止日志膨胀
- JSON 响应美化输出,便于人工阅读
"""

import json
import logging
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# 日志目录(app/server/logs/)
LOG_DIR = Path(__file__).resolve().parent / "logs"

# 不记录的路径(健康检查、文档、根路径)
EXCLUDE_PATHS = {"/api/health", "/docs", "/redoc", "/openapi.json", "/"}

# SSE 端点路径片段(流式响应,不记录响应体)
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


class APILoggingMiddleware(BaseHTTPMiddleware):
    """记录所有 API 请求和响应的中间件.

    每条日志包含:时间戳、方法、路径、查询参数、客户端 IP、
    状态码、耗时(ms)、请求体、响应体(JSON 美化)。
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        if _is_excluded(path):
            return await call_next(request)

        # 读取请求体(需缓存后重新提供给下游路由)
        req_body = await request.body()

        async def receive():
            return {"type": "http.request", "body": req_body, "more_body": False}

        request._receive = receive

        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000

        sse = _is_sse(path)
        resp_body = b""
        if not sse:
            # 非 SSE:读取响应体后重新构建 Response 返回给客户端
            async for chunk in response.body_iterator:
                resp_body += chunk
            response = Response(
                content=resp_body,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.media_type,
            )

        # 组装并写入日志
        logger = get_api_logger()
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        query = request.url.query
        client_ip = request.client.host if request.client else "-"

        req_text = _truncate(_safe_json_parse(req_body)) if req_body else ""
        if sse:
            resp_text = "[SSE stream, response body omitted]"
        else:
            resp_text = _truncate(_safe_json_parse(resp_body))

        query_str = f"?{query}" if query else ""
        logger.info(
            f"\n{'=' * 80}\n"
            f"[{ts}] {request.method} {path}{query_str}\n"
            f"  client: {client_ip}\n"
            f"  status: {response.status_code}  duration: {duration_ms:.1f}ms\n"
            f"  request_body:\n{req_text}\n"
            f"  response_body:\n{resp_text}"
        )

        return response
