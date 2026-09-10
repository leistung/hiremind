"""分析记录服务:磁盘仓储 + 初始状态工厂.

把每份分析序列化为 .hiremind/analyses/<id>.json,支持崩溃恢复和历史加载。
"""

from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AnalysisStore:
    """分析磁盘仓储.

    把每份分析序列化为 .hiremind/analyses/<id>.json，
    支持崩溃恢复和历史加载。
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, analysis_id: str) -> Path:
        """获取分析文件路径."""
        return self.root / f"{analysis_id}.json"

    def _write_atomic(self, path: Path, data: dict) -> Path:
        """原子写：先写 tmp 再 replace，避免半截 JSON.

        为什么需要:分析过程会频繁 save(每次节点完成/对话每轮),
        若进程崩溃或写盘被中断,rename 前的 tmp 文件不会损坏已存在的正式文件,
        保证历史记录可恢复。
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".tmp", dir=path.parent, delete=False
        ) as tmp:
            json.dump(data, tmp, ensure_ascii=False, indent=2)
            tmp_path = Path(tmp.name)
        tmp_path.replace(path)
        return path

    def save(self, analysis: Dict[str, Any]) -> Path:
        """保存分析到磁盘.

        若无 id 则自动生成(兜底);每次保存刷新 updated_at,
        供 list_all 按修改时间倒序展示。
        """
        analysis_id = analysis.get("id", "")
        if not analysis_id:
            analysis_id = f"analysis-{uuid4().hex[:12]}"
            analysis["id"] = analysis_id
        analysis["updated_at"] = _now()
        return self._write_atomic(self.path(analysis_id), analysis)

    def load(self, analysis_id: str) -> Optional[Dict[str, Any]]:
        """从磁盘加载分析."""
        path = self.path(analysis_id)
        if not path.exists():
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def latest(self) -> Optional[str]:
        """按修改时间取最新的分析 ID."""
        analyses = list(self.root.glob("*.json"))
        if not analyses:
            return None
        latest_file = max(analyses, key=lambda p: p.stat().st_mtime)
        return latest_file.stem

    def list_all(self) -> List[Dict[str, Any]]:
        """列出所有分析摘要（不含完整 history）.

        摘要字段是历史页/列表页所需的最小集,避免把大段 history 读进内存。
        单个文件损坏(JSONDecodeError)时跳过,不影响其余记录。
        """
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

    def delete(self, analysis_id: str) -> bool:
        """删除指定分析."""
        path = self.path(analysis_id)
        if path.exists():
            path.unlink()
            return True
        return False


def new_analysis_state(title: str = "", metadata: Optional[Dict[str, Any]] = None, model: str = "") -> Dict[str, Any]:
    """创建一份新的分析字典.

    model: 启动本次分析时后端使用的模型名称,用于前端显示"本次分析使用的模型",
    避免分析启动后用户修改全局模型配置导致显示与实际不一致。
    """
    return {
        "id": f"analysis-{uuid4().hex[:12]}",
        "created_at": _now(),
        "updated_at": _now(),
        "title": title,
        "history": [],
        "memory": {},
        "interview_result": None,
        "status": "pending",
        "error": None,
        "metadata": metadata or {},
        "model": model or "",
    }
