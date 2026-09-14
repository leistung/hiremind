from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.exc import IntegrityError
from .config import settings
from .sessions import cache
from sqlalchemy import desc
from sqlalchemy.orm import Session

from .database import get_db
from .models import Note, Project, User
from .schemas import AuthOut, LoginInput, NoteInput, NoteOut, ProjectOut, RegisterInput, UserOut
from .security import current_user, hash_password, issue_token, verify_password

router = APIRouter()


def note_out(note: Note) -> NoteOut:
    return NoteOut(id=note.id, title=note.title, body=note.body, tags=[tag for tag in note.tags.split(",") if tag], project_slug=note.project_slug, created_at=note.created_at, updated_at=note.updated_at)


@router.post("/auth/register", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterInput, response: Response, db: Session = Depends(get_db)):
    payload.email = payload.email.lower()
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=409, detail="这个邮箱已经注册过了")
    user = User(email=payload.email, display_name=payload.display_name, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="这个邮箱已经注册过了")
    db.refresh(user)
    token = issue_token(user)
    response.set_cookie("hiremind_session", token, httponly=True, secure=settings.secure_cookie, samesite="lax", max_age=1209600)
    return AuthOut(token=token, user=user)


@router.post("/auth/login", response_model=AuthOut)
def login(payload: LoginInput, request: Request, response: Response, db: Session = Depends(get_db)):
    import hashlib
    key = "login:" + hashlib.sha256((request.client.host + payload.email.lower()).encode()).hexdigest()
    if cache.incr(key) == 1:
        cache.expire(key, 300)
    if int(cache.get(key) or 0) > 15:
        raise HTTPException(status_code=429, detail="尝试过于频繁，请五分钟后重试")
    payload.email = "root@hiremind.local" if payload.email.strip().lower() == "root" else payload.email.strip().lower()
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")
    cache.delete(key)
    token = issue_token(user)
    response.set_cookie("hiremind_session", token, httponly=True, secure=settings.secure_cookie, samesite="lax", max_age=1209600)
    return AuthOut(token=token, user=user)


@router.post("/auth/logout")
def logout(request: Request, response: Response, user: User = Depends(current_user)):
    from jose import jwt
    import time
    token = request.headers.get("authorization", "").removeprefix("Bearer ") or request.cookies.get("hiremind_session")
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    cache.setex("revoked:" + payload["jti"], max(1, int(payload["exp"] - time.time())), "1")
    response.delete_cookie("hiremind_session")
    return {"success": True}


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.get("/projects", response_model=list[ProjectOut])
def projects(category: str | None = None, db: Session = Depends(get_db)):
    query = db.query(Project)
    if category and category != "全部":
        query = query.filter(Project.category == category)
    return query.order_by(desc(Project.stars)).all()


@router.get("/projects/categories", response_model=list[str])
def project_categories(db: Session = Depends(get_db)):
    return [item[0] for item in db.query(Project.category).distinct().all()]


@router.get("/notes", response_model=list[NoteOut])
def notes(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [note_out(note) for note in db.query(Note).filter(Note.user_id == user.id).order_by(desc(Note.updated_at)).all()]


@router.post("/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(payload: NoteInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    note = Note(user_id=user.id, title=payload.title, body=payload.body, tags=",".join(payload.tags), project_slug=payload.project_slug)
    db.add(note)
    db.commit()
    db.refresh(note)
    return note_out(note)


@router.put("/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: int, payload: NoteInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id, Note.user_id == user.id).first()
    if not note:
        raise HTTPException(status_code=404, detail="笔记不存在")
    note.title, note.body, note.tags, note.project_slug = payload.title, payload.body, ",".join(payload.tags), payload.project_slug
    db.commit()
    db.refresh(note)
    return note_out(note)


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id, Note.user_id == user.id).first()
    if not note:
        raise HTTPException(status_code=404, detail="笔记不存在")
    db.delete(note)
    db.commit()
