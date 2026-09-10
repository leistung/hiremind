"""模拟面试工作流的 LLM 节点(图状态化版本).

每个节点接收完整 InterviewFlowState,调 LLM,返回 state patch。
MockInterview 的状态管理逻辑已迁移到这些节点中。

节点清单:
- recommend_stages   智能规划面试阶段方案(无状态)
- start              启动面试:初始化 stages(多阶段)或出第一题(单场)
- submit_answer      提交回答 + 即时评价
- next_question      出下一题(含阶段完成/面试结束判断)
- submit_written     笔试批量提交 + 评价 + 阶段总结
- advance_stage      阶段切换
- finish             结束 + 生成最终报告
- abandon            标记放弃(不生成报告)
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from ..models.schemas import (
    InterviewReport,
    InterviewResult,
    InterviewStageTurn,
    InterviewStageType,
    InterviewTurn,
    Question,
    StageConfig,
)
from ..prompts import (
    INTERVIEW_EVALUATE_PROMPT,
    INTERVIEW_FINAL_REPORT_PROMPT,
    INTERVIEW_FIRST_QUESTION_PROMPT,
    INTERVIEW_NEXT_QUESTION_PROMPT,
    STAGE_FIRST_QUESTION_PROMPT,
    STAGE_PLANNER_PROMPT,
    STAGE_SUMMARY_PROMPT,
    WRITTEN_BATCH_EVALUATE_PROMPT,
    WRITTEN_EXAM_GENERATOR_PROMPT,
)
from ..services import get_llm


# ── 节点中文标签(用于 node_io 记录与展示)──

NODE_LABELS: Dict[str, str] = {
    "recommend_stages": "智能规划阶段",
    "start": "启动面试",
    "submit_answer": "回答评价",
    "next_question": "出下一题",
    "submit_written": "笔试评价",
    "advance_stage": "阶段切换",
    "finish": "生成最终报告",
    "abandon": "放弃面试",
}


# ── 结构化输出模型 ──


class AnswerEvaluation(BaseModel):
    evaluation: str = Field(default="", description="对该回答的即时评价,2-4 句话")
    score: int = Field(default=0, ge=0, le=10, description="本题得分 0-10")
    improvements: List[str] = Field(default_factory=list, description="改进建议,1-3 条")


class WrittenExamQuestions(BaseModel):
    questions: List[Question] = Field(default_factory=list, description="笔试题列表")


class BatchEvaluation(BaseModel):
    evaluations: List[AnswerEvaluation] = Field(default_factory=list, description="逐题评价")


class StageSummary(BaseModel):
    stage_score: int = Field(default=0, ge=0, le=100, description="本阶段得分 0-100")
    stage_summary: str = Field(default="", description="本阶段评语")
    promotion_hint: str = Field(default="", description="晋级提示")


class FinalReport(BaseModel):
    overall_score: int = Field(default=0, ge=0, le=100)
    strengths: List[str] = Field(default_factory=list)
    weak_areas: List[str] = Field(default_factory=list)
    learning_suggestions: List[str] = Field(default_factory=list)
    summary: str = Field(default="")


class StagePlanItem(BaseModel):
    stage_type: InterviewStageType
    stage_name: str = ""
    question_count: int = Field(default=10, ge=1, le=20)
    focus: str = ""
    rationale: str = ""


class StagePlan(BaseModel):
    stages: List[StagePlanItem] = Field(default_factory=list)


# ── 默认阶段配置 ──

DEFAULT_STAGE_CONFIGS: List[StageConfig] = [
    StageConfig(stage_type=InterviewStageType.WRITTEN, stage_name="笔试", question_count=15),
    StageConfig(stage_type=InterviewStageType.TECH_1, stage_name="技术一面"),
    StageConfig(stage_type=InterviewStageType.TECH_2, stage_name="技术二面"),
    StageConfig(stage_type=InterviewStageType.HR, stage_name="人事面"),
]


# ── 阶段映射(题库轮次 + 方向字段)──
#
# 分析题库存两种组织方式:rounds[](按轮次)与五个方向字段(兼容旧版)。
# _STAGE_ROUND_MAPPING:阶段类型 → 应取哪些轮次(0 基);
# _STAGE_DIRECTION_MAPPING:阶段类型 → 应取哪些方向字段。
# 二者取并集;都为空时回退到全量题库(all_questions)。

_STAGE_ROUND_MAPPING: Dict[InterviewStageType, List[int]] = {
    InterviewStageType.TECH_1: [0, 1],
    InterviewStageType.TECH_2: [2, 3],
    InterviewStageType.SYSTEM_DESIGN: [2, 3],
    InterviewStageType.BEHAVIORAL: [4],
    InterviewStageType.HR: [4],
    InterviewStageType.BOSS: [4],
}

_STAGE_DIRECTION_MAPPING: Dict[InterviewStageType, List[str]] = {
    InterviewStageType.SYSTEM_DESIGN: ["business_scenario"],
    InterviewStageType.BEHAVIORAL: ["behavioral_cultural"],
    InterviewStageType.HR: ["pressure_adaptability", "behavioral_cultural"],
    InterviewStageType.BOSS: ["resume_deep_dive", "behavioral_cultural"],
}


# ── 辅助函数 ──


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _flatten_questions(questions) -> List[Question]:
    """把按轮次/方向组织的题目拍平为线性列表.

    面试启动时把 InterviewResult.questions 拍平存入 state["all_questions"],
    之后出题/笔试兜底都从这个线性列表取,避免每个节点重复解析组织结构。
    """
    flat: List[Question] = []
    # 新版主结构:rounds[]
    for round_ in getattr(questions, "rounds", []) or []:
        flat.extend(round_.questions or [])
    # 旧版兼容结构:五个方向字段
    for attr in (
        "resume_deep_dive", "business_scenario", "technical_professional",
        "behavioral_cultural", "pressure_adaptability",
    ):
        flat.extend(getattr(questions, attr, []) or [])
    return flat


def _questions_for_stage(
    result: InterviewResult, stage_type: InterviewStageType, all_questions: List[Question]
) -> List[Question]:
    """根据阶段类型从题库提取对应题目.

    规则:轮次映射 ∩ 方向映射的并集;若某阶段两类都没有(如笔试不入表),
    回退用全量题库,保证任何阶段都有题可出。
    """
    rounds = getattr(result.questions, "rounds", []) or []
    qs: List[Question] = []
    for idx in _STAGE_ROUND_MAPPING.get(stage_type, []):
        if idx < len(rounds):
            qs.extend(rounds[idx].questions or [])
    for attr in _STAGE_DIRECTION_MAPPING.get(stage_type, []):
        qs.extend(getattr(result.questions, attr, []) or [])
    if not qs:
        qs = list(all_questions)
    return qs


def _analysis_summary(result: InterviewResult) -> str:
    """把匹配度/风险压成 3 行摘要,作为 LLM 出题/评分的精简上下文."""
    ma = result.match_analysis
    return (
        f"匹配度: {ma.match_score}/100\n"
        f"强项: {'; '.join(ma.strong_points[:3])}\n"
        f"弱项: {'; '.join(ma.weak_points[:3])}\n"
        f"风险: {'; '.join(r.risk_type for r in result.risks[:3])}"
    )


def _history_text(turns: List[InterviewTurn], full: bool = False) -> str:
    """把轮次列表渲染成 Q/A 文本.

    full=False:只含题目与回答(供下一题决策,避免评价内容泄漏);
    full=True:追加评价与得分(供最终报告生成)。
    """
    lines: List[str] = []
    for t in turns:
        lines.append(f"Q{t.turn_index}: {t.question}")
        if t.answer:
            lines.append(f"  A: {t.answer}")
        if full and t.evaluated:
            lines.append(f"  评价({t.score}/10): {t.evaluation}")
    return "\n".join(lines)


def _stage_history_text(stage_turns: List[InterviewTurn]) -> str:
    lines: List[str] = []
    for t in stage_turns:
        lines.append(f"Q{t.turn_index}: {t.question}")
        if t.answer:
            lines.append(f"  A: {t.answer}")
        if t.evaluated:
            lines.append(f"  评价({t.score}/10): {t.evaluation}")
    return "\n".join(lines)


def _record_node_io(state: Dict, action: str, payload: Dict, output: Dict, error: Optional[str]) -> List:
    """追加一条 node_io 记录.

    以 action 为键记录本次执行的输入/输出/错误,追加到 state["node_io"]。
    read_node_io 工具按 action 名过滤读取,前端据此还原"每一步发生了什么"。
    """
    entry = {
        action: {
            "label": NODE_LABELS.get(action, action),
            "input": payload,
            "output": output,
            "error": error,
            "ts": _now(),
        }
    }
    return (state.get("node_io") or []) + [entry]


# ── LLM 调用辅助函数 ──
#
# 每个 _llm_* 是"一次独立的 LLM 调用"的封装:
# 从 input dict 取值,拼 prompt,绑定输出模型(自由文本除外),返回结构化结果。
# 节点函数只负责编排与状态更新,LLM 调用细节全部收敛到这里。

def _llm_recommend_stages(input: Dict) -> Dict:
    llm = get_llm()
    structured_llm = llm.with_structured_output(StagePlan)
    chain = STAGE_PLANNER_PROMPT | structured_llm
    plan = chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "company_business_scope": input.get("company_business_scope") or "（未提供）",
        "jd_summary": (input.get("jd_summary") or "")[:1500] or "（未提供 JD）",
        "match_analysis": input.get("match_analysis", ""),
        "business_scenarios": input.get("business_scenarios", ""),
        "risks": input.get("risks", ""),
        "expected_rounds": input.get("expected_rounds", 4),
    })
    return {"stages": [s.model_dump() for s in plan.stages]}


def _llm_start_dialogue(input: Dict) -> str:
    llm = get_llm()
    chain = STAGE_FIRST_QUESTION_PROMPT | llm
    resp = chain.invoke({
        "stage_name": input.get("stage_name", ""),
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "analysis_summary": input.get("analysis_summary", ""),
        "stage_questions": input.get("stage_questions", ""),
    })
    return (resp.content if hasattr(resp, "content") else str(resp)).strip()


def _llm_start_first(input: Dict) -> str:
    llm = get_llm()
    chain = INTERVIEW_FIRST_QUESTION_PROMPT | llm
    resp = chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "analysis_summary": input.get("analysis_summary", ""),
        "first_round_questions": input.get("first_round_questions", ""),
    })
    return (resp.content if hasattr(resp, "content") else str(resp)).strip()


def _llm_generate_written(input: Dict) -> List[Question]:
    llm = get_llm()
    structured_llm = llm.with_structured_output(WrittenExamQuestions)
    chain = WRITTEN_EXAM_GENERATOR_PROMPT | structured_llm
    result = chain.invoke({
        "question_count": input.get("question_count", 10),
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "match_analysis": input.get("match_analysis", ""),
        "business_scenarios": input.get("business_scenarios", ""),
        "risks": input.get("risks", ""),
        "jd_profile": input.get("jd_profile", ""),
    })
    return result.questions


def _llm_evaluate_written(input: Dict) -> List[AnswerEvaluation]:
    llm = get_llm()
    structured_llm = llm.with_structured_output(BatchEvaluation)
    chain = WRITTEN_BATCH_EVALUATE_PROMPT | structured_llm
    batch = chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "count": input.get("count", 0),
        "qa_pairs": input.get("qa_pairs", ""),
    })
    return batch.evaluations


def _llm_evaluate_answer(input: Dict) -> AnswerEvaluation:
    llm = get_llm()
    structured_llm = llm.with_structured_output(AnswerEvaluation)
    chain = INTERVIEW_EVALUATE_PROMPT | structured_llm
    return chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "question": input.get("question", ""),
        "focus": input.get("focus", ""),
        "reference_answer": input.get("reference_answer", ""),
        "answer": input.get("answer", ""),
    })


def _llm_next_question(input: Dict) -> str:
    llm = get_llm()
    chain = INTERVIEW_NEXT_QUESTION_PROMPT | llm
    resp = chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "history": input.get("history", ""),
        "remaining_questions": input.get("remaining_questions", ""),
    })
    return (resp.content if hasattr(resp, "content") else str(resp)).strip()


def _llm_summarize_stage(input: Dict) -> StageSummary:
    llm = get_llm()
    structured_llm = llm.with_structured_output(StageSummary)
    chain = STAGE_SUMMARY_PROMPT | structured_llm
    return chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "stage_name": input.get("stage_name", ""),
        "stage_log": input.get("stage_log", ""),
    })


def _llm_final_report(input: Dict) -> FinalReport:
    llm = get_llm()
    structured_llm = llm.with_structured_output(FinalReport)
    chain = INTERVIEW_FINAL_REPORT_PROMPT | structured_llm
    return chain.invoke({
        "company_name": input.get("company_name", ""),
        "job_title": input.get("job_title", ""),
        "qa_log": input.get("qa_log", ""),
    })


# ── 阶段控制辅助 ──


def _enter_stage(state: Dict, result: InterviewResult, all_questions: List[Question], stage_index: int) -> Dict:
    """进入指定阶段,返回 state patch.

    两条分支:
    - 笔试阶段:LLM 一次性生成 5-20 题(失败兜底从题库取前 N 题),
      写入 stage.written_questions,返回 __WRITTEN_READY__ 信号(无当前题);
    - 对话阶段:取题库中该阶段的题目,LLM 口语化出第一题
      (失败直接用题库首题原文),写入 turns 与当前阶段,返回 question_text。
    """
    stage_configs = state.get("stage_configs") or []
    if stage_index >= len(stage_configs):
        # 阶段索引越界说明所有阶段已跑完,直接进入收尾(生成最终报告)
        return _finish(state, result)

    cfg = StageConfig.model_validate(stage_configs[stage_index])
    stages = [dict(s) for s in (state.get("stages") or [])]
    if stage_index < len(stages):
        stages[stage_index]["status"] = "in_progress"

    if cfg.stage_type == InterviewStageType.WRITTEN:
        # 笔试:一次性生成所有题目
        # 题数 clamp 在 [5, 20],与 StageConfig.question_count 的语义一致
        count = max(5, min(20, cfg.question_count))
        match_json = result.match_analysis.model_dump_json(indent=2)
        scenarios_json = "\n\n".join(s.model_dump_json(indent=2) for s in result.business_scenarios)
        risks_json = "\n\n".join(r.model_dump_json(indent=2) for r in result.risks)
        try:
            questions = _llm_generate_written({
                "question_count": count,
                "company_name": result.company_name,
                "job_title": result.job_title,
                "match_analysis": match_json,
                "business_scenarios": scenarios_json,
                "risks": risks_json,
                "jd_profile": "",
            })
            written_qs = questions[:count]
        except Exception:
            # LLM 出题失败:从全量题库截取,保证笔试流程不中断
            written_qs = all_questions[:count]

        if stage_index < len(stages):
            stages[stage_index]["written_questions"] = [q.model_dump() for q in written_qs]
        node_io = _record_node_io(state, "generate_written", {
            "question_count": count, "company_name": result.company_name,
            "job_title": result.job_title,
        }, {"questions_count": len(written_qs)}, None)
        return {
            "current_stage_index": stage_index,
            "stages": stages,
            "status": "answering",
            "node_io": node_io,
            "output": {"signal": "__WRITTEN_READY__"},
        }

    # 对话阶段:出第一题
    stage_qs = _questions_for_stage(result, cfg.stage_type, all_questions)
    summary = _analysis_summary(result)
    qs_text = "\n".join(f"- {q.title}: {q.question}" for q in stage_qs[:4])
    question_text = ""
    try:
        question_text = _llm_start_dialogue({
            "stage_name": cfg.stage_name,
            "company_name": result.company_name,
            "job_title": result.job_title,
            "analysis_summary": summary,
            "stage_questions": qs_text,
        })
    except Exception:
        pass

    if stage_qs:
        first = stage_qs[0]
        current_q = Question(
            title=first.title,
            question=question_text or first.question,
            focus=first.focus,
            reference_answer=first.reference_answer,
            direction=first.direction,
        )
    else:
        current_q = Question(
            title=f"{cfg.stage_name}-开场",
            question=question_text or f"欢迎参加{cfg.stage_name}。请先做一个简单的自我介绍。",
            focus="沟通能力",
            reference_answer="",
        )

    used_titles = list(state.get("used_question_titles") or [])
    used_titles.append(current_q.title)
    turns = [InterviewTurn.model_validate(t) for t in (state.get("turns") or [])]
    turn = InterviewTurn(turn_index=len(turns) + 1, question=current_q.question)
    turns.append(turn)

    # 同步到当前阶段
    if stage_index < len(stages):
        stage_turns = [InterviewTurn.model_validate(t) for t in stages[stage_index].get("turns", [])]
        stage_turns.append(turn)
        stages[stage_index]["turns"] = [t.model_dump() for t in stage_turns]

    node_io = _record_node_io(state, "start_dialogue", {
        "stage_name": cfg.stage_name, "company_name": result.company_name,
        "job_title": result.job_title,
    }, {"question_text": current_q.question}, None)

    return {
        "current_stage_index": stage_index,
        "stages": stages,
        "status": "answering",
        "current_question": current_q.model_dump(),
        "used_question_titles": used_titles,
        "turns": [t.model_dump() for t in turns],
        "node_io": node_io,
        "output": {"question_text": current_q.question},
    }


def _complete_stage(state: Dict, result: InterviewResult, stage_index: int) -> Dict:
    """完成当前阶段,生成阶段总结.

    流程:
    1. 把本阶段 turns 渲染成 stage_log;
    2. LLM 生成阶段总结(stage_score/stage_summary/promotion_hint);
    3. LLM 失败时降级:按已评题目平均分 ×10 折算,按阈值生成晋级提示;
    4. 标记该阶段 completed,记录 node_io。
    """
    stages = [dict(s) for s in (state.get("stages") or [])]
    if stage_index >= len(stages):
        return {}
    stage = stages[stage_index]
    stage_turns = [InterviewTurn.model_validate(t) for t in stage.get("turns", [])]
    stage_log = _stage_history_text(stage_turns)

    try:
        summary = _llm_summarize_stage({
            "company_name": result.company_name,
            "job_title": result.job_title,
            "stage_name": stage.get("stage_name", ""),
            "stage_log": stage_log,
        })
        stage["stage_score"] = summary.stage_score
        stage["stage_summary"] = summary.stage_summary
        stage["promotion_hint"] = summary.promotion_hint
    except Exception:
        # 降级:平均分 ×10 折算成 0-100,按阈值给通用晋级提示
        evaluated = [t for t in stage_turns if t.evaluated]
        avg = sum(t.score for t in evaluated) / max(1, len(evaluated)) * 10
        stage["stage_score"] = int(avg)
        stage["stage_summary"] = "阶段总结生成失败"
        stage["promotion_hint"] = (
            "表现优秀,进入下一阶段" if avg >= 70
            else "基本合格,继续努力" if avg >= 50
            else "表现不理想,真实场景可能被淘汰,但练习继续"
        )
    stage["status"] = "completed"

    node_io = _record_node_io(state, "summarize_stage", {
        "stage_name": stage.get("stage_name", ""),
    }, {"stage_score": stage["stage_score"]}, None)

    return {"stages": stages, "node_io": node_io}


def _finish(state: Dict, result: InterviewResult) -> Dict:
    """生成最终报告,返回 state patch.

    流程:
    1. 把全部 turns 渲染成完整 qa_log(含评价与得分);
    2. LLM 生成最终报告(overall_score/strengths/weak_areas/suggestions/summary);
    3. 降级:LLM 失败时 overall_score=0 + 错误摘要,再用已评平均分回填总分;
    4. 组装 InterviewReport(多阶段模式附带分阶段成绩),状态置 finished。
    """
    turns = [InterviewTurn.model_validate(t) for t in (state.get("turns") or [])]
    qa_log = _history_text(turns, full=True)
    report_data = None
    try:
        report_data = _llm_final_report({
            "company_name": result.company_name,
            "job_title": result.job_title,
            "qa_log": qa_log,
        }).model_dump()
    except Exception as exc:
        report_data = {
            "overall_score": 0,
            "strengths": [],
            "weak_areas": [],
            "learning_suggestions": [],
            "summary": f"报告生成失败: {exc}",
        }

    # 已评题平均分 ×10 作为总分回填(LLM 返回 0 或缺失时用)
    evaluated = [t for t in turns if t.evaluated]
    avg_score = (sum(t.score for t in evaluated) / max(1, len(evaluated))) * 10
    overall = report_data.get("overall_score", 0) or int(avg_score)

    stages = state.get("stages") or []
    is_multi = state.get("is_multi_stage", False)
    report = InterviewReport(
        interview_id=state.get("interview_id", ""),
        analysis_id=state.get("analysis_id", ""),
        company_name=result.company_name,
        job_title=result.job_title,
        overall_score=overall,
        rounds_completed=len(turns),
        turns=turns,
        strengths=report_data.get("strengths", []),
        weak_areas=report_data.get("weak_areas", []),
        learning_suggestions=report_data.get("learning_suggestions", []),
        summary=report_data.get("summary", ""),
        created_at=_now(),
        stages=[InterviewStageTurn.model_validate(s) for s in stages] if is_multi else [],
        stages_completed=sum(1 for s in stages if s.get("status") == "completed"),
    )

    node_io = _record_node_io(state, "final_report", {
        "company_name": result.company_name, "job_title": result.job_title,
    }, {"overall_score": overall}, None)

    return {
        "status": "finished",
        "report": report.model_dump(),
        "node_io": node_io,
        "output": {"signal": "__INTERVIEW_FINISHED__"},
    }


# ── 节点函数(接收 state,返回 state patch)──
#
# 每个节点与 InterviewFlowGraph 的 action 一一对应,
# 通过 graph.invoke(state, action, payload) 被调用。

def recommend_stages_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """智能规划面试阶段方案(无状态,只用 payload).

    不读会话状态,纯粹把 payload(公司/岗位/匹配度/场景/风险/期望轮次)
    交给 LLM 规划,产出写入 output.stages。
    """
    payload = state.get("payload") or {}
    try:
        out = _llm_recommend_stages(payload)
        return {"output": out}
    except Exception as exc:
        return {"error": f"阶段规划失败: {exc}"}


def start_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """启动面试:初始化 stages(多阶段)或出第一题(单场).

    多阶段:按 stage_configs 生成 stages 骨架,进入阶段 0;
    单场:直接从全量题库出第一题(LLM 口语化改写,失败用题库首题)。
    两种分支都会把 all_questions 拍平写入 state,后续节点不再重复解析。
    """
    result = InterviewResult.model_validate(state["result"])
    all_questions = _flatten_questions(result.questions)
    is_multi = state.get("is_multi_stage", False)

    # 初始化 all_questions 到 state
    base_patch: Dict[str, Any] = {"all_questions": [q.model_dump() for q in all_questions]}

    if is_multi:
        stage_configs = [StageConfig.model_validate(s) for s in (state.get("stage_configs") or [])]
        stages = [
            InterviewStageTurn(
                stage_type=cfg.stage_type,
                stage_name=cfg.stage_name or cfg.stage_type.value,
            ).model_dump()
            for cfg in stage_configs
        ]
        base_patch["stages"] = stages
        base_patch["current_stage_index"] = 0
        patch = _enter_stage({**state, **base_patch}, result, all_questions, 0)
        return {**base_patch, **patch}

    # 单场模式:出第一题
    if not all_questions:
        current_q = Question(
            title="开场",
            question="请简单做一个自我介绍,重点说说为什么适合这个岗位。",
            focus="沟通能力与岗位匹配度",
            reference_answer="",
        )
    else:
        first = all_questions[0]
        summary = _analysis_summary(result)
        first_round_qs = "\n".join(f"- {q.title}: {q.question}" for q in all_questions[:3])
        question_text = ""
        try:
            question_text = _llm_start_first({
                "company_name": result.company_name,
                "job_title": result.job_title,
                "analysis_summary": summary,
                "first_round_questions": first_round_qs,
            })
        except Exception:
            pass
        current_q = Question(
            title=first.title,
            question=question_text or first.question,
            focus=first.focus,
            reference_answer=first.reference_answer,
            direction=first.direction,
        )

    used_titles = list(state.get("used_question_titles") or []) + [current_q.title]
    turn = InterviewTurn(turn_index=1, question=current_q.question)
    node_io = _record_node_io(state, "start_first", {
        "company_name": result.company_name, "job_title": result.job_title,
    }, {"question_text": current_q.question}, None)

    return {
        **base_patch,
        "status": "answering",
        "current_question": current_q.model_dump(),
        "used_question_titles": used_titles,
        "turns": [turn.model_dump()],
        "node_io": node_io,
        "output": {"question_text": current_q.question},
    }


def submit_answer_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """提交回答 + 即时评价.

    只评价"最近一道题"(turns 的最后一轮):
    1. 校验:回答非空、面试已开始(存在 current_question 与 turns);
    2. 把回答写入当前 turn,调 LLM 评价(score 0-10 + 评语 + 改进建议);
    3. LLM 失败降级:5 分 + 错误信息评语;
    4. 状态置 evaluated(下一题节点据此判断"上一题已评完")。
    """
    payload = state.get("payload") or {}
    answer = (payload.get("answer") or "").strip()
    if not answer:
        return {"error": "回答不能为空"}

    result = InterviewResult.model_validate(state["result"])
    current_q = Question.model_validate(state["current_question"]) if state.get("current_question") else None
    if not current_q:
        return {"error": "面试尚未开始,无法提交回答"}

    turns = [InterviewTurn.model_validate(t) for t in (state.get("turns") or [])]
    if not turns:
        return {"error": "面试尚未开始,无法提交回答"}

    current_turn = turns[-1]
    current_turn.answer = answer
    # 参考答案优先用新字段 reference_answer,缺失回退到旧字段 reference_hint
    reference_answer = (
        current_q.reference_answer or current_q.reference_hint
        or "(无参考答案,请按回答完整度与深度评分)"
    )

    try:
        eva = _llm_evaluate_answer({
            "company_name": result.company_name,
            "job_title": result.job_title,
            "question": current_q.question,
            "focus": current_q.focus,
            "reference_answer": reference_answer,
            "answer": answer,
        })
        current_turn.evaluation = eva.evaluation
        current_turn.score = eva.score
        current_turn.improvements = eva.improvements
    except Exception as exc:
        # 评价失败:给保底 5 分,保证阶段总结/最终报告的平均分可计算
        current_turn.evaluation = f"评价生成失败: {exc}"
        current_turn.score = 5
        current_turn.improvements = []
    current_turn.evaluated = True

    node_io = _record_node_io(state, "evaluate_answer", {
        "question": current_q.question, "answer": answer[:200],
    }, {"score": current_turn.score}, None)

    return {
        "turns": [t.model_dump() for t in turns],
        "status": "evaluated",
        "node_io": node_io,
        "output": current_turn.model_dump(),
    }


def next_question_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """出下一题(含阶段完成/面试结束判断).

    前置条件:上一题必须已评价(status == evaluated),防止重复出题跳过评价。

    结束判断(按优先级):
    1. 多阶段:当前对话阶段轮次达到上限 → _complete_stage,发 __STAGE_COMPLETED__;
    2. 单场:总轮次达到 max_turns → _finish;
    3. 题库用完且没有历史轮次 → _finish。

    正常出题:LLM 基于历史表现从剩余题库挑/改写下一题(失败用题库首题原文),
    并把新轮次同步到全局 turns 与当前阶段 turns。
    """
    result = InterviewResult.model_validate(state["result"])
    all_questions = [Question.model_validate(q) for q in (state.get("all_questions") or [])]
    if not all_questions:
        all_questions = _flatten_questions(result.questions)
    turns = [InterviewTurn.model_validate(t) for t in (state.get("turns") or [])]
    max_turns = state.get("max_turns", 8)
    is_multi = state.get("is_multi_stage", False)
    used_titles = list(state.get("used_question_titles") or [])

    if state.get("status") != "evaluated":
        return {"error": "请先提交并评价上一题的回答"}

    # 多阶段:检查阶段完成
    if is_multi:
        stages = state.get("stages") or []
        stage_idx = state.get("current_stage_index", 0)
        if stage_idx < len(stages):
            cfg = StageConfig.model_validate((state.get("stage_configs") or [])[stage_idx])
            if cfg.stage_type != InterviewStageType.WRITTEN:
                stage_turns = [InterviewTurn.model_validate(t) for t in stages[stage_idx].get("turns", [])]
                if len(stage_turns) >= max(1, max_turns):
                    patch = _complete_stage(state, result, stage_idx)
                    return {**patch, "output": {"signal": "__STAGE_COMPLETED__"}}

    # 单场:检查结束
    if not is_multi and len(turns) >= max_turns:
        return _finish(state, result)

    remaining = [q for q in all_questions if q.title not in used_titles]
    if not remaining and not turns:
        return _finish(state, result)

    history = _history_text(turns)
    remaining_text = (
        "\n".join(f"- {q.title}: {q.question}" for q in remaining[:8])
        if remaining else "(题库已用完,可基于候选人薄弱点追问)"
    )

    question_text = ""
    try:
        question_text = _llm_next_question({
            "company_name": result.company_name,
            "job_title": result.job_title,
            "history": history,
            "remaining_questions": remaining_text,
        })
    except Exception:
        if remaining:
            question_text = remaining[0].question
        else:
            return _finish(state, result)

    # 匹配题库
    matched: Optional[Question] = None
    for q in remaining:
        if q.question in question_text or question_text in q.question:
            matched = q
            break
    if matched is None and remaining:
        matched = remaining[0]
    if matched is None:
        matched = Question(title="追问", question=question_text, focus="综合能力", reference_answer="")
    else:
        matched = matched.model_copy(update={"question": question_text})

    used_titles.append(matched.title)
    next_turn = InterviewTurn(turn_index=len(turns) + 1, question=question_text)
    turns.append(next_turn)

    # 多阶段:同步到当前阶段
    stages_patch = {}
    if is_multi:
        stages = [dict(s) for s in (state.get("stages") or [])]
        stage_idx = state.get("current_stage_index", 0)
        if stage_idx < len(stages):
            stage_turns = [InterviewTurn.model_validate(t) for t in stages[stage_idx].get("turns", [])]
            stage_turns.append(next_turn)
            stages[stage_idx]["turns"] = [t.model_dump() for t in stage_turns]
            stages_patch = {"stages": stages}

    node_io = _record_node_io(state, "next_question", {
        "history": history[:500],
    }, {"question_text": question_text}, None)

    return {
        **stages_patch,
        "current_question": matched.model_dump(),
        "used_question_titles": used_titles,
        "turns": [t.model_dump() for t in turns],
        "status": "answering",
        "node_io": node_io,
        "output": {"question_text": question_text},
    }


def submit_written_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """笔试批量提交 + 评价 + 阶段总结.

    流程:
    1. 按题目索引组织 answers(dict[int, str]),逐题构建 InterviewTurn;
    2. LLM 批量评价(fail 时每题 5 分兜底),写入 stage_turns;
    3. 阶段总结(与 _complete_stage 相同的 LLM/降级逻辑);
    4. 状态置 evaluated,output 携带逐题成绩 + 阶段得分供前端展示。
    """
    payload = state.get("payload") or {}
    answers: Dict[int, str] = {int(k): v for k, v in (payload.get("answers") or {}).items()}

    result = InterviewResult.model_validate(state["result"])
    stages = [dict(s) for s in (state.get("stages") or [])]
    stage_idx = state.get("current_stage_index", 0)
    if stage_idx >= len(stages):
        return {"error": "当前无有效阶段"}
    stage = stages[stage_idx]
    if stage.get("stage_type") != InterviewStageType.WRITTEN.value:
        return {"error": "当前阶段不是笔试"}
    questions = [Question.model_validate(q) for q in (stage.get("written_questions") or [])]
    if not questions:
        return {"error": "笔试题目未生成"}

    # 构建 turns
    # 未作答的题也生成 turn(答案留空),评价时 LLM 会看到"(未作答)"
    turns = [InterviewTurn.model_validate(t) for t in (state.get("turns") or [])]
    stage_turns: List[InterviewTurn] = []
    qa_pairs_parts: List[str] = []
    for idx, q in enumerate(questions):
        ans = (answers.get(idx) or "").strip()
        turn = InterviewTurn(
            turn_index=len(turns) + idx + 1,
            question=q.question,
            answer=ans,
        )
        stage_turns.append(turn)
        qa_pairs_parts.append(
            f"第{idx + 1}题:\n题目: {q.question}\n参考答案: {q.reference_answer}\n候选人回答: {ans or '(未作答)'}"
        )

    # 批量评价
    qa_pairs_text = "\n\n".join(qa_pairs_parts)
    try:
        evaluations = _llm_evaluate_written({
            "company_name": result.company_name,
            "job_title": result.job_title,
            "count": len(questions),
            "qa_pairs": qa_pairs_text,
        })
        for idx, eva in enumerate(evaluations):
            if idx < len(stage_turns):
                stage_turns[idx].evaluation = eva.evaluation
                stage_turns[idx].score = eva.score
                stage_turns[idx].improvements = eva.improvements
                stage_turns[idx].evaluated = True
    except Exception as exc:
        for t in stage_turns:
            t.evaluation = f"评价生成失败: {exc}"
            t.score = 5
            t.evaluated = True

    stage["turns"] = [t.model_dump() for t in stage_turns]
    turns.extend(stage_turns)

    node_io_e = _record_node_io(state, "evaluate_written", {
        "count": len(questions),
    }, {"evaluations_count": len(stage_turns)}, None)

    # 阶段总结
    stage_log = _stage_history_text(stage_turns)
    try:
        summary = _llm_summarize_stage({
            "company_name": result.company_name,
            "job_title": result.job_title,
            "stage_name": stage.get("stage_name", ""),
            "stage_log": stage_log,
        })
        stage["stage_score"] = summary.stage_score
        stage["stage_summary"] = summary.stage_summary
        stage["promotion_hint"] = summary.promotion_hint
    except Exception:
        evaluated = [t for t in stage_turns if t.evaluated]
        avg = sum(t.score for t in evaluated) / max(1, len(evaluated)) * 10
        stage["stage_score"] = int(avg)
        stage["stage_summary"] = "阶段总结生成失败"
        stage["promotion_hint"] = (
            "表现优秀,进入下一阶段" if avg >= 70
            else "基本合格,继续努力" if avg >= 50
            else "表现不理想,真实场景可能被淘汰,但练习继续"
        )
    stage["status"] = "completed"

    node_io = _record_node_io({**state, "node_io": node_io_e}, "summarize_stage", {
        "stage_name": stage.get("stage_name", ""),
    }, {"stage_score": stage["stage_score"]}, None)

    return {
        "stages": stages,
        "turns": [t.model_dump() for t in turns],
        "status": "evaluated",
        "node_io": node_io,
        "output": {
            "turns": [t.model_dump() for t in stage_turns],
            "stage_score": stage["stage_score"],
            "stage_summary": stage["stage_summary"],
            "promotion_hint": stage["promotion_hint"],
        },
    }


def advance_stage_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """阶段切换:进入下一阶段.

    用户确认晋级后调用:
    - 还有阶段 → _enter_stage(next_idx),进入下一阶段出题;
    - 已到末尾 → _finish,生成最终报告。
    """
    result = InterviewResult.model_validate(state["result"])
    all_questions = [Question.model_validate(q) for q in (state.get("all_questions") or [])]
    if not all_questions:
        all_questions = _flatten_questions(result.questions)

    stage_configs = state.get("stage_configs") or []
    next_idx = state.get("current_stage_index", 0) + 1
    if next_idx >= len(stage_configs):
        # 所有阶段已完成,收尾
        return _finish(state, result)

    return _enter_stage(state, result, all_questions, next_idx)


def finish_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """主动结束面试,生成最终报告.

    与"自然结束"走同一 _finish 逻辑,前端"结束面试"按钮调用。
    """
    result = InterviewResult.model_validate(state["result"])
    return _finish(state, result)


def abandon_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """放弃面试(不生成报告).

    幂等:若已 finished/abandoned 直接返回现状,不重复覆盖。
    """
    if state.get("status") in ("finished", "abandoned"):
        return {"output": {"status": state["status"]}}
    return {"status": "abandoned", "output": {"status": "abandoned"}}


# 节点注册表:action 名称 → 节点函数
INTERVIEW_NODES: Dict[str, Any] = {
    "recommend_stages": recommend_stages_node,
    "start": start_node,
    "submit_answer": submit_answer_node,
    "next_question": next_question_node,
    "submit_written": submit_written_node,
    "advance_stage": advance_stage_node,
    "finish": finish_node,
    "abandon": abandon_node,
}
