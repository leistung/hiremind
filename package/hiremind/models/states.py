"""LangGraph 工作流状态 schema 集中定义.

两个图状态集中在此,与业务模型(schemas.py)分离:
- AnalysisFlowState  分析流状态(分析图节点间传递)
- InterviewFlowState 面试流状态(模拟面试图节点间传递)
"""

from __future__ import annotations

from typing import Annotated, Any, Dict, List, Optional

from pydantic import BaseModel
from typing_extensions import TypedDict

from .schemas import (
    BusinessScenario,
    InterviewInput,
    InterviewQuestions,
    JDProfile,
    MatchAnalysis,
    ResumeProfile,
    Risk,
)


def _merge_errors(existing: Optional[str], new: Optional[str]) -> Optional[str]:
    """LangGraph reducer:合并多个并行节点可能产生的错误信息.

    为什么需要:分析图第一层 parse_jd/parse_resume 与第二层
    analyze_match/infer_scenarios/identify_risks 都是并行节点。
    若没有 reducer,后写入的 error 会覆盖先写入的,导致只看到最后一个错误;
    有了拼接逻辑,所有节点的失败原因都能保留。
    LangGraph 中通过 Annotated[Optional[str], _merge_errors] 声明该字段用此 reducer。
    """
    if not new:
        return existing
    if not existing:
        return new
    return f"{existing}\n{new}"


class AnalysisFlowState(BaseModel):
    """分析流状态(分析图的 LangGraph 共享状态).

    节点间通过本状态传递:
    input → jd_profile / resume_profile → match_analysis / business_scenarios / risks
    → questions → preparation_tips。

    之所以用 Pydantic BaseModel(而非 TypedDict):
    LangGraph 对 Pydantic 状态的节点更新按字段合并,
    配合 _merge_errors 的 Annotated reducer 即可处理并行节点写冲突。
    """

    input: InterviewInput
    jd_profile: Optional[JDProfile] = None
    resume_profile: Optional[ResumeProfile] = None
    match_analysis: Optional[MatchAnalysis] = None
    business_scenarios: Optional[List[BusinessScenario]] = None
    risks: Optional[List[Risk]] = None
    questions: Optional[InterviewQuestions] = None
    preparation_tips: Optional[List[str]] = None
    error: Annotated[Optional[str], _merge_errors] = None


class InterviewFlowState(TypedDict, total=False):
    """面试流状态(模拟面试图的 LangGraph 共享状态).

    包含三类字段:
    1. 元数据(初始化时设置,只读):interview_id / analysis_id / result / ...
    2. 会话状态(节点可读写):status / turns / current_question / stages / ...
    3. 单次执行控制:action / payload / output / error
       (action 由 invoke() 写入,路由节点按它分发;
        output/error 由节点写入,invoke() 返回给外层)

    total=False 使所有字段可选,节点 patch 只需返回改动的键。
    状态整体由外层 InterviewStore 持久化为 JSON。
    """

    # ── 元数据 ──
    interview_id: str
    analysis_id: str
    result: Dict[str, Any]       # InterviewResult.model_dump()
    max_turns: int
    is_multi_stage: bool
    stage_configs: list          # List[StageConfig.model_dump()]
    created_at: str
    all_questions: list          # 拍平的题库 List[Question.model_dump()]

    # ── 会话状态 ──
    status: str                  # started / answering / evaluated / finished / abandoned
    turns: list                  # List[InterviewTurn.model_dump()]
    current_question: Optional[Dict[str, Any]]
    used_question_titles: list
    stages: list                 # List[InterviewStageTurn.model_dump()]
    current_stage_index: int
    report: Optional[Dict[str, Any]]
    node_io: list                # 节点级输入输出记录

    # ── 单次执行控制 ──
    action: str
    payload: Dict[str, Any]
    output: Optional[Dict[str, Any]]
    error: Optional[str]
