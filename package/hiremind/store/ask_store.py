"""Ask 单次运行的完整存储:状态机快照 + 审计工件落盘.

- AskState:内存中的状态机对象(running/completed/stopped/failed + tool_steps/attempts)
- AskStore :把 AskState 落盘到 .hiremind/runs/<run_id>/{task_state.json, trace.jsonl, report.json}

两者合并自原 ask_store + run_store,只服务 ask(),与 graph 无关。
"""

from __future__ import annotations

import json
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

# 状态常量
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_STOPPED = "stopped"
STATUS_FAILED = "failed"

# 停止原因
STOP_REASON_FINAL_ANSWER = "final_answer_returned"
STOP_REASON_STEP_LIMIT = "step_limit_reached"
STOP_REASON_RETRY_LIMIT = "retry_limit_reached"
STOP_REASON_MODEL_ERROR = "model_error"
STOP_REASON_TOOL_ERROR = "tool_error"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class AskState:
    """一次 ask() 运行过程中的状态机快照.

    状态流转:
        running → completed(finish_success)
                → stopped(stop_step_limit / stop_retry_limit)
                → failed(stop_model_error)

    每个字段都由对应方法更新(runtime.ask 不直接改字段),
    保证状态机语义集中在数据类内部。
    """

    run_id: str = ""
    task_id: str = ""
    user_request: str = ""
    status: str = STATUS_RUNNING
    tool_steps: int = 0
    attempts: int = 0
    last_tool: str = ""
    stop_reason: str = ""
    final_answer: str = ""
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    @classmethod
    def create(cls, user_request: str) -> "AskState":
        """工厂方法：创建一个新的运行状态.

        run_id 12 位、task_id 8 位,均为 uuid hex(可读且不冲突)。
        """
        run_id = f"run-{uuid4().hex[:12]}"
        task_id = f"task-{uuid4().hex[:8]}"
        return cls(run_id=run_id, task_id=task_id, user_request=user_request)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AskState":
        """从字典反序列化."""
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def record_attempt(self) -> "AskState":
        """记录一次模型调用."""
        self.attempts += 1
        self.updated_at = _now()
        return self

    def record_tool(self, name: str) -> "AskState":
        """记录一次工具执行."""
        self.tool_steps += 1
        self.last_tool = name
        self.updated_at = _now()
        return self

    def finish_success(self, final_answer: str) -> "AskState":
        """正常完成."""
        self.status = STATUS_COMPLETED
        self.stop_reason = STOP_REASON_FINAL_ANSWER
        self.final_answer = final_answer
        self.updated_at = _now()
        return self

    def stop_step_limit(self) -> "AskState":
        """达到步数上限."""
        self.status = STATUS_STOPPED
        self.stop_reason = STOP_REASON_STEP_LIMIT
        self.updated_at = _now()
        return self

    def stop_retry_limit(self) -> "AskState":
        """达到重试上限."""
        self.status = STATUS_STOPPED
        self.stop_reason = STOP_REASON_RETRY_LIMIT
        self.updated_at = _now()
        return self

    def stop_model_error(self, error: str = "") -> "AskState":
        """模型调用出错."""
        self.status = STATUS_FAILED
        self.stop_reason = STOP_REASON_MODEL_ERROR
        self.final_answer = error
        self.updated_at = _now()
        return self

    def to_dict(self) -> Dict[str, Any]:
        """序列化为字典."""
        return asdict(self)


# ────────────────────────────────────────────────────────────────
# AskStore:把 AskState 落盘到磁盘(原 run_store 逻辑)
# ────────────────────────────────────────────────────────────────

class AskStore:
    """Ask 运行审计仓储.

    每次 ask() 生成一个独立 run 目录:
        .hiremind/runs/<run_id>/
        ├── task_state.json    # 状态机快照
        ├── trace.jsonl        # 事件流(流式追加)
        └── report.json        # 最终报告
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def run_dir(self, task_state: AskState) -> Path:
        """获取 run 目录路径."""
        return self.root / task_state.run_id

    def task_state_path(self, task_state: AskState) -> Path:
        return self.run_dir(task_state) / "task_state.json"

    def trace_path(self, task_state: AskState) -> Path:
        return self.run_dir(task_state) / "trace.jsonl"

    def report_path(self, task_state: AskState) -> Path:
        return self.run_dir(task_state) / "report.json"

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
        """开始一次运行:创建目录 + 写初始 task_state.

        同时写第一条 run_started 事件,便于按 run_id 回溯每次 ask 的起点。
        """
        run_dir = self.run_dir(task_state)
        run_dir.mkdir(parents=True, exist_ok=True)
        self.write_task_state(task_state)
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
        """向 trace.jsonl 追加一条事件.

        JSONL 每行一个事件,追加写(可流式审计),事件类型:
        run_started / prompt_built / model_response / model_error /
        tool_called / tool_result / retry / run_finished。
        排查 Agent 决策过程时按时间顺序读即可。
        """
        path = self.trace_path(task_state)
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "timestamp": _now(),
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
        path = self.root / run_id / "task_state.json"
        if not path.exists():
            return None
        with open(path, encoding="utf-8") as f:
            return AskState.from_dict(json.load(f))

    def load_report(self, run_id: str) -> Optional[Dict[str, Any]]:
        """加载报告."""
        path = self.root / run_id / "report.json"
        if not path.exists():
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)
