"""Idempotent, checksum-verified, non-destructive local workspace import."""
import hashlib
from collections import Counter
from pathlib import Path
from sqlalchemy import select
from .config import settings
from .models import MigrationReceipt, PrepState, User, WorkspaceFile
from .preparation import Preparation
from .security import hash_password


def bootstrap(db):
    user = db.scalar(select(User).where(User.email == "root@hiremind.local"))
    if not user:
        user = User(email="root@hiremind.local", display_name="root", password_hash=hash_password("0000"))
        db.add(user)
        db.flush()
    if not db.get(PrepState, user.id):
        db.add(PrepState(user_id=user.id, data=Preparation().model_dump(), revision=0))
    key = "local-workspace-v1"
    if db.get(MigrationReceipt, key):
        db.commit()
        return
    source = Path(settings.legacy_source)
    if not source.is_dir():
        raise RuntimeError("Legacy source mount missing; refusing an empty migration")
    counts, total_bytes = Counter(), 0
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.is_symlink() or path.name == ".DS_Store":
            continue
        relative = str(path.relative_to(source))
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        db.add(WorkspaceFile(user_id=user.id, path=relative, content=content, checksum=digest))
        total_bytes += len(content)
        counts[relative.split("/")[0]] += 1
    db.flush()
    for record in db.scalars(select(WorkspaceFile).where(WorkspaceFile.user_id == user.id)):
        if hashlib.sha256(record.content).hexdigest() != record.checksum:
            raise RuntimeError("Migration checksum verification failed")
    db.add(MigrationReceipt(key=key, user_id=user.id, report={"files": sum(counts.values()), "bytes": total_bytes, "categories": dict(counts), "verified": True}))
    db.commit()
