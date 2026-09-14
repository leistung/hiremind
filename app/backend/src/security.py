from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .models import User

passwords = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto", pbkdf2_sha256__rounds=600000)
bearer = HTTPBearer(auto_error=False)
ALGORITHM = "HS256"


def hash_password(value: str) -> str:
    return passwords.hash(value)


def verify_password(value: str, hashed: str) -> bool:
    return passwords.verify(value, hashed)


def issue_token(user: User) -> str:
    expires = datetime.now(timezone.utc) + timedelta(days=14)
    import uuid
    return jwt.encode({"sub": str(user.id), "exp": expires, "jti": uuid.uuid4().hex}, settings.jwt_secret, algorithm=ALGORITHM)


def current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    token = credentials.credentials if credentials else request.cookies.get("hiremind_session")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
        from .sessions import cache
        if cache.exists("revoked:" + payload.get("jti", "")):
            raise ValueError("revoked")
        user = db.get(User, int(payload["sub"]))
    except (JWTError, KeyError, TypeError, ValueError):
        user = None
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态已失效")
    return user
