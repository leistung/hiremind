"""模拟面试会话服务:磁盘仓储 + 初始状态工厂(图状态化版本).

基于 JSON 文件存取 InterviewFlowState,直接存取 state dict。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class InterviewStore:
    """模拟面试会话存储(基于 JSON 文件).

    存储格式与旧版 MockInterview.to_dict() 兼容,
    但 state 字段对齐 InterviewFlowState schema。
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, interview_id: str) -> Path:
        return self.root / f"{interview_id}.json"

    def save(self, interview_id: str, state: Dict[str, Any]) -> Path:
        """保存 state 到 JSON 文件."""
        path = self._path(interview_id)
        path.write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return path

    def load(self, interview_id: str) -> Optional[Dict[str, Any]]:
        """加载 state,返回 dict 或 None."""
        path = self._path(interview_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def list_all(self) -> List[dict]:
        """列出所有面试会话摘要(按创建时间倒序)."""
        items: List[dict] = []
        for p in sorted(self.root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                report = data.get("report") or {}
                result = data.get("result") or {}
                items.append({
                    "id": data.get("interview_id", data.get("id", "")),
                    "analysis_id": data.get("analysis_id", ""),
                    "status": data.get("status", ""),
                    "company_name": result.get("company_name", ""),
                    "job_title": result.get("job_title", ""),
                    "turns": len(data.get("turns", [])),
                    "created_at": data.get("created_at", ""),
                    "overall_score": report.get("overall_score", 0) if report else 0,
                    "rounds_completed": report.get("rounds_completed", 0) if report else 0,
                    "summary": report.get("summary", "") if report else "",
                    "is_multi_stage": data.get("is_multi_stage", False),
                    "stages_completed": report.get("stages_completed", 0) if report else 0,
                })
            except Exception:
                continue
        return items

    def delete(self, interview_id: str) -> bool:
        """删除面试会话文件."""
        path = self._path(interview_id)
        if path.exists():
            path.unlink()
            return True
        return False


def new_interview_state(
    analysis_id: str,
    result: Any,
    max_turns: int = 8,
    stage_configs: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """创建一场新的模拟面试初始 state.

    Args:
        analysis_id: 关联的分析记录 ID
        result: InterviewResult 对象(会 model_dump 存入 state)
        max_turns: 单场模式最大轮次(多阶段时为每阶段题数上限)
        stage_configs: 阶段配置列表(非空则多阶段模式)

    Returns:
        初始 InterviewFlowState dict(未持久化,调用方需 save)
    """
    # result 可能是 InterviewResult 对象或 dict
    result_dict = result.model_dump() if hasattr(result, "model_dump") else result

    return {
        "interview_id": f"iv-{uuid.uuid4().hex[:12]}",
        "analysis_id": analysis_id,
        "result": result_dict,
        "max_turns": max_turns,
        "is_multi_stage": bool(stage_configs),
        "stage_configs": stage_configs or [],
        "created_at": _now(),
        "status": "started",
        "turns": [],
        "current_question": None,
        "used_question_titles": [],
        "stages": [],
        "current_stage_index": 0,
        "report": None,
        "node_io": [],
    }
