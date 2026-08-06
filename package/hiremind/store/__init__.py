"""存储层:集中管理各类持久化仓储与运行状态.

- analysis_store   分析记录磁盘仓储
- interview_store  模拟面试会话磁盘仓储
- resume_store     简历磁盘仓储
- position_store   职位/JD 磁盘仓储
- ask_store        单次 ask() 的运行状态机快照
- run_store        单次 ask() 运行的审计工件落盘器
"""

from .analysis_store import AnalysisStore, new_analysis_state
from .ask_store import AskState
from .interview_store import InterviewStore, new_interview_state
from .position_store import PositionStore
from .resume_store import ResumeStore
from .run_store import RunStore

__all__ = [
    "AnalysisStore",
    "InterviewStore",
    "ResumeStore",
    "PositionStore",
    "AskState",
    "RunStore",
    "new_analysis_state",
    "new_interview_state",
]
