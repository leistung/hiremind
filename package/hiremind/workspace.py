"""Workspace：本地工作目录管理，管理 .hiremind/ 下的所有产物."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import List, Optional


class HireMindWorkspace:
    """面试工作区.

    管理以下目录结构：
        .hiremind/
        ├── sessions/    # 会话 JSON
        ├── runs/        # 单次运行审计
        ├── memory/      # 持久记忆
        ├── reports/     # 导出的报告文件
        ├── resumes/     # 简历 JSON
        ├── positions/   # 职位/JD JSON
        ├── interviews/  # 模拟面试 JSON
        └── assets/      # 上传的图片等资源
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.hiremind_dir = self.root / ".hiremind"
        self.sessions_dir = self.hiremind_dir / "sessions"
        self.runs_dir = self.hiremind_dir / "runs"
        self.memory_dir = self.hiremind_dir / "memory"
        self.reports_dir = self.hiremind_dir / "reports"
        self.resumes_dir = self.hiremind_dir / "resumes"
        self.positions_dir = self.hiremind_dir / "positions"
        self.interviews_dir = self.hiremind_dir / "interviews"
        self.assets_dir = self.hiremind_dir / "assets"

    def ensure_dirs(self) -> None:
        """确保所有子目录存在."""
        for d in (
            self.hiremind_dir,
            self.sessions_dir,
            self.runs_dir,
            self.memory_dir,
            self.memory_dir / "resumes",
            self.memory_dir / "topics",
            self.reports_dir,
            self.resumes_dir,
            self.positions_dir,
            self.interviews_dir,
            self.assets_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)

    # ── reports 增删改查 ──

    def list_reports(self) -> List[Path]:
        """列出所有导出的报告文件."""
        if not self.reports_dir.exists():
            return []
        return sorted(self.reports_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)

    def save_report(self, name: str, data: bytes) -> Path:
        """保存报告文件到工作区."""
        self.ensure_dirs()
        path = self.reports_dir / name
        path.write_bytes(data)
        return path

    def delete_report(self, name: str) -> None:
        """删除指定报告."""
        path = self.reports_dir / name
        if path.exists():
            path.unlink()

    def get_report(self, name: str) -> Optional[bytes]:
        """读取报告内容."""
        path = self.reports_dir / name
        if path.exists():
            return path.read_bytes()
        return None

    # ── assets 增删查 ──

    def save_asset(self, name: str, data: bytes) -> Path:
        """保存上传的资源文件(图片等)到工作区."""
        self.ensure_dirs()
        path = self.assets_dir / name
        path.write_bytes(data)
        return path

    def get_asset_path(self, name: str) -> Optional[Path]:
        """获取资源文件路径,不存在返回 None."""
        path = self.assets_dir / name
        return path if path.exists() else None

    # ── 指纹 ──

    def fingerprint(self) -> str:
        """工作区状态指纹（用于判断是否有变化）."""
        h = hashlib.sha256()
        for d in (self.sessions_dir, self.runs_dir, self.reports_dir):
            if d.exists():
                for f in sorted(d.rglob("*")):
                    if f.is_file():
                        h.update(str(f.relative_to(self.root)).encode())
                        h.update(str(f.stat().st_mtime).encode())
        return h.hexdigest()[:16]
