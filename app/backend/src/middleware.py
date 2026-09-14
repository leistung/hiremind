import asyncio
from fastapi import HTTPException, Request
from starlette.responses import JSONResponse
from .config import settings
from .database import SessionLocal
from .security import current_user
from .engine_adapter import user_context
from .workspace_repository import hydrate, flush


class AccountBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] == "OPTIONS":
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        path = scope["path"]
        # Same-origin browser requests and configured frontend origins only for
        # mutations. Bearer clients without Origin remain supported.
        origin = request.headers.get("origin")
        if scope["method"] not in ("GET", "HEAD") and origin and origin not in settings.origins:
            return await JSONResponse({"detail": "不允许的请求来源"}, 403)(scope, receive, send)
        if not path.startswith("/api/workbench"):
            return await self.app(scope, receive, send)
        from fastapi.security import HTTPAuthorizationCredentials
        auth = request.headers.get("authorization", "")
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=auth[7:]) if auth.startswith("Bearer ") else None
        try:
            with SessionLocal() as db:
                user = await asyncio.to_thread(current_user, request, credentials, db)
                user_id, is_root = user.id, user.email == "root@hiremind.local"
            if path.startswith("/api/workbench/models") and not is_root:
                raise HTTPException(403, "模型服务设置仅限管理员")
            if ".." in path or "\\" in path or "\x00" in path:
                raise HTTPException(400, "无效的资源路径")
        except HTTPException as exc:
            return await JSONResponse({"detail": exc.detail}, exc.status_code)(scope, receive, send)
        await asyncio.to_thread(hydrate, user_id)
        token = user_context.set(user_id)
        try:
            await self.app(scope, receive, send)
        finally:
            await asyncio.to_thread(flush, user_id)
            user_context.reset(token)
