"""RunStore:单次 ask() 运行的审计工件落盘器."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Union

from .ask_store import AskState


def _run_id(value: Union[str, AskState]) -> str:
    """兼容传入 AskState 对象或字符串 run_id."""
    if isinstance(value, AskState):
        return value.run_id
    return str(value)


class RunStore:
    """单次运行审计仓储.

    每次 ask() 生成一个独立 run 目录：
        .hiremind/runs/<run_id>/
        ├── task_state.json    # 状态机快照
        ├── trace.jsonl        # 事件流（流式追加）
        └── report.json        # 最终报告
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def run_dir(self, run_id: Union[str, AskState]) -> Path:
        """获取 run 目录路径."""
        rid = _run_id(run_id)
        return self.root / rid

    def task_state_path(self, run_id: Union[str, AskState]) -> Path:
        return self.run_dir(run_id) / "task_state.json"

    def trace_path(self, run_id: Union[str, AskState]) -> Path:
        return self.run_dir(run_id) / "trace.jsonl"

    def report_path(self, run_id: Union[str, AskState]) -> Path:
        return self.run_dir(run_id) / "report.json"

    def _write_json_atomic(self, path: Path, payload: dict) -> Path:
        """原子写 JSON."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".tmp", dir=path.parent, delete=False
        ) as tmp:
            json.dump(payload, tmp, ensure_ascii=False, indent=2)
            tmp_path = Path(tmp.name)
        tmp_path.replace(path)
        return path

    def start_run(self, task_state: AskState) -> Path:
        """开始一次运行：创建目录 + 写初始 task_state."""
        run_dir = self.run_dir(task_state)
        run_dir.mkdir(parents=True, exist_ok=True)
        self.write_task_state(task_state)
        # 写 trace 起始行
        self.append_trace(task_state, "run_started", {
            "user_request": task_state.user_request,
        })
        return run_dir

    def write_task_state(self, task_state: AskState) -> Path:
        """写入 task_state.json."""
        return self._write_json_atomic(
            self.task_state_path(task_state), task_state.to_dict()
        )

    def append_trace(
        self,
        task_state: AskState,
        event: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Path:
        """向 trace.jsonl 追加一条事件."""
        from datetime import datetime, timezone

        path = self.trace_path(task_state)
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run_id": task_state.run_id,
            "event": event,
            "payload": payload or {},
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return path

    def write_report(
        self, task_state: AskState, report: Dict[str, Any]
    ) -> Path:
        """写入最终报告."""
        report["run_id"] = task_state.run_id
        report["task_id"] = task_state.task_id
        return self._write_json_atomic(self.report_path(task_state), report)

    def load_task_state(self, run_id: str) -> Optional[AskState]:
        """加载 task_state."""
        path = self.task_state_path(run_id)
        if not path.exists():
            return None
        with open(path, encoding="utf-8") as f:
            return AskState.from_dict(json.load(f))

    def load_report(self, run_id: str) -> Optional[Dict[str, Any]]:
        """加载报告."""
        path = self.report_path(run_id)
        if not path.exists():
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)
