"""职位/JD 存储:本地 JSON 文件 CRUD."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from ..models.schemas import Position


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PositionStore:
    """职位/JD 本地存储(JSON 文件)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, position_id: str) -> Path:
        return self.root / f"{position_id}.json"

    def list_all(self) -> List[Position]:
        items: List[Position] = []
        for p in sorted(self.root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                items.append(Position.model_validate(data))
            except Exception:
                continue
        return items

    def get(self, position_id: str) -> Optional[Position]:
        path = self._path(position_id)
        if not path.exists():
            return None
        try:
            return Position.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return None

    def save(self, position: Position) -> Position:
        ts = _now()
        if not position.created_at:
            position.created_at = ts
        position.updated_at = ts
        self._path(position.id).write_text(
            position.model_dump_json(indent=2), encoding="utf-8"
        )
        return position

    def delete(self, position_id: str) -> bool:
        path = self._path(position_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def create(
        self,
        name: str = "",
        company_name: str = "",
        company_business_scope: str = "",
        job_title: str = "",
        job_requirements: str = "",
        notes: str = "",
    ) -> Position:
        """创建新职位(自动生成 pos-{12位hex} ID,立即落盘).

        默认名称:公司 · 岗位;两者都空则用"未命名职位"。
        """
        # 自动生成默认名称:公司+职位,若都为空则用"未命名职位"
        default_name = (
            name
            or " · ".join(filter(None, [company_name.strip(), job_title.strip()]))
            or "未命名职位"
        )
        position = Position(
            id=f"pos-{uuid.uuid4().hex[:12]}",
            name=default_name,
            company_name=company_name,
            company_business_scope=company_business_scope,
            job_title=job_title,
            job_requirements=job_requirements,
            notes=notes,
        )
        return self.save(position)
