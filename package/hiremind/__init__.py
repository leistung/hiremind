"""HireMind: 基于 JD + 简历的 AI 模拟面试核心包.

顶层只导出最常用 API(记忆口诀见 PACKAGE_GUIDE.md):
- HireMindAgent:面试 Agent 运行时(最核心入口,ask/run_tool/面试编排);
- HireMindMemory / HireMindWorkspace:记忆与工作区;
- AnalysisGraph:分析流水线;
- 三个 Store + AskState/AskStore:持久化与运行审计;
- InterviewInput / InterviewResult:分析流水线进出料;
- new_analysis_state / new_interview_state:状态工厂。

服务层(services/)、节点(nodes/)、提示词(prompts/)等按需单独导入。
"""

from .graph.analysis_graph import AnalysisGraph
from .memory import HireMindMemory
from .models.schemas import InterviewInput, InterviewResult
from .runtime import HireMindAgent
from .store import (
    AnalysisStore,
    AskState,
    AskStore,
    InterviewStore,
    new_analysis_state,
    new_interview_state,
)
from .workspace import HireMindWorkspace

__all__ = [
    "HireMindAgent",
    "HireMindMemory",
    "HireMindWorkspace",
    "AnalysisGraph",
    "AnalysisStore",
    "InterviewStore",
    "AskState",
    "AskStore",
    "InterviewInput",
    "InterviewResult",
    "new_analysis_state",
    "new_interview_state",
]
