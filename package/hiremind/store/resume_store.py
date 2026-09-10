"""简历存储:本地 JSON 文件 CRUD."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from ..models.schemas import Resume, ResumeData


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ResumeStore:
    """简历本地存储(JSON 文件)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, resume_id: str) -> Path:
        return self.root / f"{resume_id}.json"

    def list_all(self) -> List[Resume]:
        items: List[Resume] = []
        for p in sorted(self.root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                items.append(Resume.model_validate(data))
            except Exception:
                continue
        return items

    def get(self, resume_id: str) -> Optional[Resume]:
        path = self._path(resume_id)
        if not path.exists():
            return None
        try:
            return Resume.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return None

    def save(self, resume: Resume) -> Resume:
        """保存简历(新建时补 created_at,每次刷新 updated_at).

        以 model_dump_json 序列化(含 data 结构),单文件存整份简历。
        """
        ts = _now()
        if not resume.created_at:
            resume.created_at = ts
        resume.updated_at = ts
        self._path(resume.id).write_text(
            resume.model_dump_json(indent=2), encoding="utf-8"
        )
        return resume

    def delete(self, resume_id: str) -> bool:
        path = self._path(resume_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def create(self, name: str = "", data: Optional[ResumeData] = None) -> Resume:
        """创建一份新简历(自动生成 resume-{12位hex} ID,立即落盘)."""
        resume = Resume(
            id=f"resume-{uuid.uuid4().hex[:12]}",
            name=name or "未命名简历",
            data=data or ResumeData(),
        )
        return self.save(resume)
