from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class RegisterInput(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=80)


class LoginInput(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    email: str
    display_name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class AuthOut(BaseModel):
    token: str
    user: UserOut


class NoteInput(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = ""
    tags: list[str] = []
    project_slug: str | None = None


class NoteOut(BaseModel):
    id: int
    title: str
    body: str
    tags: list[str]
    project_slug: str | None
    created_at: datetime
    updated_at: datetime


class ProjectOut(BaseModel):
    model_config = {"from_attributes": True}
    slug: str
    name: str
    category: str
    summary: str
    github_url: str
    deepwiki_url: str | None
    language: str
    stars: int
    loc: int
    loc_delta: int
