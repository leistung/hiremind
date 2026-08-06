"""AskState:单次 ask() 的状态机快照.

记录一次 ask() 运行过程中的状态:进行到哪了、调了多少次工具、最后为什么停下。
会被不断写入 task_state.json,供运行中观察和运行后复盘。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict
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
    """一次 ask() 运行过程中的状态机快照."""

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
        """工厂方法：创建一个新的运行状态."""
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
