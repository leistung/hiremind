"""Database persistence and disposable filesystem materialization for the AI engine.

MySQL is the durable store. Filesystem paths exist only to preserve the existing
document/AI library contracts. Every request flushes changes; background store
writes are flushed immediately by the engine adapter.
"""
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from threading import RLock
from sqlalchemy import select
from .database import SessionLocal
from .models import WorkspaceFile
from .config import settings

locks: dict[int, RLock] = {}
loaded: set[int] = set()


def root(user_id: int) -> Path:
    return Path(settings.runtime_root) / str(user_id) / ".hiremind"


def safe_path(base: Path, relative: str) -> Path:
    path = (base / relative).resolve()
    if not path.is_relative_to(base.resolve()):
        raise ValueError("Invalid workspace path")
    return path


def hydrate(user_id: int) -> None:
    with locks.setdefault(user_id, RLock()):
        if user_id in loaded:
            return
        with SessionLocal() as db:
            for record in db.scalars(select(WorkspaceFile).where(WorkspaceFile.user_id == user_id)):
                path = safe_path(root(user_id), record.path)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(record.content)
                timestamp = record.updated_at.timestamp()
                if path.suffix == ".json":
                    try:
                        payload = json.loads(record.content)
                        value = payload.get("updated_at") or payload.get("created_at")
                        if value:
                            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
                    except (ValueError, AttributeError, TypeError):
                        pass
                os.utime(path, (timestamp, timestamp))
        loaded.add(user_id)


def flush(user_id: int) -> None:
    with locks.setdefault(user_id, RLock()):
        base = root(user_id)
        with SessionLocal() as db:
            existing = {item.path: item for item in db.scalars(select(WorkspaceFile).where(WorkspaceFile.user_id == user_id))}
            seen = set()
            for path in base.rglob("*"):
                if not path.is_file() or path.is_symlink() or path.suffix == ".tmp":
                    continue
                relative = str(path.relative_to(base))
                content = path.read_bytes()
                digest = hashlib.sha256(content).hexdigest()
                seen.add(relative)
                item = existing.get(relative)
                if not item:
                    db.add(WorkspaceFile(user_id=user_id, path=relative, content=content, checksum=digest))
                elif item.checksum != digest:
                    item.content, item.checksum = content, digest
            for relative in existing.keys() - seen:
                db.delete(existing[relative])
            db.commit()


def user_from_path(path: Path) -> int | None:
    try:
        return int(Path(path).resolve().relative_to(Path(settings.runtime_root).resolve()).parts[0])
    except (ValueError, IndexError):
        return None
