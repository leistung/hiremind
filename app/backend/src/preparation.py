"""User-owned preparation state, with optimistic concurrency and one-time import."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from .database import get_db
from .models import MigrationReceipt, PrepState, User
from .security import current_user

router = APIRouter()


class NoteItem(BaseModel):
    id: str = Field(max_length=100)
    title: str = Field(max_length=300)
    body: str = Field(max_length=1000000)
    tag: str = Field(max_length=300)


class TaskItem(BaseModel):
    id: str = Field(max_length=100)
    text: str = Field(max_length=2000)
    done: bool


class Preparation(BaseModel):
    saved: list[str] = Field(default_factory=list, max_length=1000)
    notes: list[NoteItem] = Field(default_factory=list, max_length=2000)
    tasks: list[TaskItem] = Field(default_factory=list, max_length=2000)
    drafts: list[NoteItem] = Field(default_factory=list, max_length=2000)


class Update(Preparation):
    revision: int = Field(ge=0)


def state(db, user):
    item = db.get(PrepState, user.id)
    if not item:
        item = PrepState(user_id=user.id, data=Preparation().model_dump(), revision=0)
        db.add(item)
        from sqlalchemy.exc import IntegrityError
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            item = db.get(PrepState, user.id)
    return item


@router.get("/preparation")
def read(user: User = Depends(current_user), db: Session = Depends(get_db)):
    item = state(db, user)
    return {**item.data, "revision": item.revision}


@router.put("/preparation")
def write(payload: Update, user: User = Depends(current_user), db: Session = Depends(get_db)):
    state(db, user)
    updated = db.query(PrepState).filter(PrepState.user_id == user.id, PrepState.revision == payload.revision).update({"data": payload.model_dump(exclude={"revision"}), "revision": payload.revision + 1})
    if not updated:
        db.rollback()
        raise HTTPException(409, "数据已在其他页面更新，请刷新后再编辑")
    db.commit()
    return {"revision": payload.revision + 1}


@router.post("/preparation/import-local")
def import_local(payload: Preparation, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.email != "root@hiremind.local":
        raise HTTPException(403, "现有本地工作区仅迁入 root 账号")
    state(db, user)
    db.commit()
    item = db.query(PrepState).filter_by(user_id=user.id).with_for_update().one()
    import hashlib, json
    fingerprint = hashlib.sha256(json.dumps(payload.model_dump(), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    key = "browser:" + fingerprint
    if db.query(MigrationReceipt).filter_by(key=key).with_for_update().first():
        return {**item.data, "revision": item.revision}
    merged = dict(item.data)
    for kind in ("notes", "tasks", "drafts"):
        existing = {entry["id"] for entry in merged[kind]}
        merged[kind] = merged[kind] + [entry.model_dump() for entry in getattr(payload, kind) if entry.id not in existing]
    merged["saved"] = list(dict.fromkeys(merged["saved"] + payload.saved))
    item.data, item.revision = merged, item.revision + 1
    db.add(MigrationReceipt(key=key, user_id=user.id, report={k: len(v) for k, v in payload.model_dump().items()}))
    db.commit()
    return {**item.data, "revision": item.revision}


@router.get("/migration-report")
def report(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [{"key": item.key, "report": item.report, "created_at": item.created_at} for item in db.query(MigrationReceipt).filter_by(user_id=user.id)]
