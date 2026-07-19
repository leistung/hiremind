"""SessionStore：跨轮可恢复会话的磁盘仓储."""

from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SessionStore:
    """会话磁盘仓储.

    把整个 session 序列化为 .hiremind/sessions/<id>.json，
    支持崩溃恢复和继续对话。
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, session_id: str) -> Path:
        """获取 session 文件路径."""
        return self.root / f"{session_id}.json"

    def _write_atomic(self, path: Path, data: dict) -> Path:
        """原子写：先写 tmp 再 replace，避免半截 JSON."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".tmp", dir=path.parent, delete=False
        ) as tmp:
            json.dump(data, tmp, ensure_ascii=False, indent=2)
            tmp_path = Path(tmp.name)
        tmp_path.replace(path)
        return path

    def save(self, session: Dict[str, Any]) -> Path:
        """保存 session 到磁盘."""
        session_id = session.get("id", "")
        if not session_id:
            session_id = f"session-{uuid4().hex[:12]}"
            session["id"] = session_id
        session["updated_at"] = _now()
        return self._write_atomic(self.path(session_id), session)

    def load(self, session_id: str) -> Optional[Dict[str, Any]]:
        """从磁盘加载 session."""
        path = self.path(session_id)
        if not path.exists():
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def latest(self) -> Optional[str]:
        """按修改时间取最新的 session ID."""
        sessions = list(self.root.glob("*.json"))
        if not sessions:
            return None
        latest_file = max(sessions, key=lambda p: p.stat().st_mtime)
        return latest_file.stem

    def list_all(self) -> List[Dict[str, Any]]:
        """列出所有 session 摘要（不含完整 history）."""
        result = []
        for path in sorted(self.root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                result.append({
                    "id": data.get("id", path.stem),
                    "title": data.get("title", ""),
                    "created_at": data.get("created_at", ""),
                    "updated_at": data.get("updated_at", ""),
                    "message_count": len(data.get("history", [])),
                    "metadata": data.get("metadata", {}),
                })
            except (json.JSONDecodeError, KeyError):
                continue
        return result

    def delete(self, session_id: str) -> bool:
        """删除指定 session."""
        path = self.path(session_id)
        if path.exists():
            path.unlink()
            return True
        return False


def new_session(title: str = "", metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """创建一个新的 session 字典."""
    return {
        "id": f"session-{uuid4().hex[:12]}",
        "created_at": _now(),
        "updated_at": _now(),
        "title": title,
        "history": [],
        "memory": {},
        "interview_result": None,
        "metadata": metadata or {},
    }
