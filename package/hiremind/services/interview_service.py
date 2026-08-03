"""模拟面试服务：多阶段面试流程、自适应提问、即时评价、最终报告."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from langchain_core.language_models.chat_models import BaseChatModel
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
    STAGE_SUMMARY_PROMPT,
    WRITTEN_BATCH_EVALUATE_PROMPT,
    WRITTEN_EXAM_GENERATOR_PROMPT,
)
from .llm_service import get_llm


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── 评价结构(LLM 结构化输出)──


class _AnswerEvaluation(BaseModel):
    """单题评价结构."""

    evaluation: str = Field(default="", description="对该回答的即时评价,2-4 句话")
    score: int = Field(default=0, ge=0, le=10, description="本题得分 0-10")
    improvements: List[str] = Field(default_factory=list, description="改进建议,1-3 条")


class _WrittenExamQuestions(BaseModel):
    """笔试批量出题结构."""

    questions: List[Question] = Field(default_factory=list, description="笔试题列表")


class _BatchEvaluation(BaseModel):
    """笔试批量评价结构."""

    evaluations: List[_AnswerEvaluation] = Field(default_factory=list, description="逐题评价")


class _StageSummary(BaseModel):
    """阶段总结结构."""

    stage_score: int = Field(default=0, ge=0, le=100, description="本阶段得分 0-100")
    stage_summary: str = Field(default="", description="本阶段评语")
    promotion_hint: str = Field(default="", description="晋级提示")


class _FinalReport(BaseModel):
    """最终报告结构(不含元数据)."""

    overall_score: int = Field(default=0, ge=0, le=100)
    strengths: List[str] = Field(default_factory=list)
    weak_areas: List[str] = Field(default_factory=list)
    learning_suggestions: List[str] = Field(default_factory=list)
    summary: str = Field(default="")


# ── 默认阶段配置 ──

DEFAULT_STAGE_CONFIGS: List[StageConfig] = [
    StageConfig(stage_type=InterviewStageType.WRITTEN, stage_name="笔试", question_count=15),
    StageConfig(stage_type=InterviewStageType.TECH_1, stage_name="技术一面"),
    StageConfig(stage_type=InterviewStageType.TECH_2, stage_name="技术二面"),
    StageConfig(stage_type=InterviewStageType.HR, stage_name="人事面"),
]

# 阶段映射到题库轮次索引(0-based),题库不足时取模循环
_STAGE_ROUND_MAPPING: Dict[InterviewStageType, List[int]] = {
    InterviewStageType.TECH_1: [0, 1],   # 第1-2轮:技术基础
    InterviewStageType.TECH_2: [2, 3],   # 第3-4轮:业务场景/系统设计
    InterviewStageType.HR: [4],          # 第5轮:行为/文化
}


# ── 模拟面试会话 ──

class MockInterview:
    """一场模拟面试的运行时状态.

    支持两种模式:
    1. 单场线性(旧版,向后兼容): max_turns 控制, start/next_question/finish
    2. 多阶段(新版): stages 配置, start_multi_stage/submit_written_answers/
       complete_current_stage/advance_to_next_stage

    存储为 JSON 文件,支持中断恢复。
    """

    def __init__(
        self,
        interview_id: str,
        analysis_id: str,
        result: InterviewResult,
        resume_text: str = "",
        max_turns: int = 8,
        model_client: Optional[BaseChatModel] = None,
        stage_configs: Optional[List[StageConfig]] = None,
    ):
        self.id = interview_id
        self.analysis_id = analysis_id
        self.result = result
        self.resume_text = resume_text
        self.max_turns = max_turns
        self.llm = model_client or get_llm()

        self.turns: List[InterviewTurn] = []
        self.current_question: Optional[Question] = None
        self.used_question_titles: List[str] = []
        self.all_questions: List[Question] = self._flatten_questions(result.questions)
        self.status: str = "started"  # started / answering / evaluated / finished
        self.created_at: str = _now()
        self.report: Optional[InterviewReport] = None

        # 多阶段字段
        self.stage_configs: List[StageConfig] = stage_configs or []
        self.stages: List[InterviewStageTurn] = []
        self.current_stage_index: int = 0
        self.is_multi_stage: bool = bool(stage_configs)

    @staticmethod
    def _flatten_questions(questions) -> List[Question]:
        """把按轮次组织的题目拍平为线性列表."""
        flat: List[Question] = []
        for round_ in getattr(questions, "rounds", []) or []:
            flat.extend(round_.questions or [])
        # 兼容旧版按方向分组的字段
        for attr in (
            "resume_deep_dive",
            "business_scenario",
            "technical_professional",
            "behavioral_cultural",
            "pressure_adaptability",
        ):
            flat.extend(getattr(questions, attr, []) or [])
        return flat

    # ── 多阶段流程控制 ──

    def start_multi_stage(self) -> str:
        """启动多阶段面试,初始化阶段记录并进入第一个阶段.

        返回:
        - 笔试阶段:返回 "__WRITTEN_READY__"(题目已生成,等待批量提交)
        - 对话阶段:返回第一题文本
        """
        # 初始化所有阶段记录
        self.stages = [
            InterviewStageTurn(
                stage_type=cfg.stage_type,
                stage_name=cfg.stage_name or cfg.stage_type.value,
            )
            for cfg in self.stage_configs
        ]
        self.current_stage_index = 0
        return self._enter_stage(0)

    def _enter_stage(self, stage_index: int) -> str:
        """进入指定阶段,根据类型启动笔试或出第一题."""
        if stage_index >= len(self.stage_configs):
            return self._finish()
        self.current_stage_index = stage_index
        cfg = self.stage_configs[stage_index]
        stage = self.stages[stage_index]
        stage.status = "in_progress"

        if cfg.stage_type == InterviewStageType.WRITTEN:
            # 笔试:一次性生成所有题目
            questions = self._generate_written_questions(cfg.question_count)
            stage.written_questions = questions
            self.status = "answering"  # 笔试也算 answering,等待批量提交
            return "__WRITTEN_READY__"

        # 对话阶段:出第一题
        return self._start_dialogue_stage(cfg, stage)

    def _start_dialogue_stage(self, cfg: StageConfig, stage: InterviewStageTurn) -> str:
        """对话阶段出第一题."""
        stage_qs = self._questions_for_stage(cfg.stage_type)
        if not stage_qs:
            # 题库无对应题目,降级用开场题
            self.current_question = Question(
                title=f"{cfg.stage_name}-开场",
                question=f"欢迎参加{cfg.stage_name}。请先做一个简单的自我介绍。",
                focus="沟通能力",
                reference_answer="",
            )
        else:
            first = stage_qs[0]
            try:
                summary = self._analysis_summary()
                qs_text = "\n".join(f"- {q.title}: {q.question}" for q in stage_qs[:4])
                chain = STAGE_FIRST_QUESTION_PROMPT | self.llm
                resp = chain.invoke(
                    {
                        "stage_name": cfg.stage_name,
                        "company_name": self.result.company_name,
                        "job_title": self.result.job_title,
                        "analysis_summary": summary,
                        "stage_questions": qs_text,
                    }
                )
                question_text = (
                    resp.content if hasattr(resp, "content") else str(resp)
                ).strip()
                self.current_question = Question(
                    title=first.title,
                    question=question_text or first.question,
                    focus=first.focus,
                    reference_answer=first.reference_answer,
                    direction=first.direction,
                )
            except Exception:
                self.current_question = stage_qs[0]

        self.used_question_titles.append(self.current_question.title)
        turn = InterviewTurn(
            turn_index=len(self.turns) + 1,
            question=self.current_question.question,
        )
        self.turns.append(turn)
        stage.turns.append(turn)
        self.status = "answering"
        return self.current_question.question

    def _questions_for_stage(self, stage_type: InterviewStageType) -> List[Question]:
        """根据阶段类型从题库轮次中提取对应题目."""
        rounds = getattr(self.result.questions, "rounds", []) or []
        round_indices = _STAGE_ROUND_MAPPING.get(stage_type, [])
        qs: List[Question] = []
        for idx in round_indices:
            if idx < len(rounds):
                qs.extend(rounds[idx].questions or [])
        # 题库不足时,从全部题目补充
        if not qs:
            qs = list(self.all_questions)
        return qs

    def _generate_written_questions(self, count: int) -> List[Question]:
        """生成笔试题目."""
        # clamp 到 [5, 20]:对话阶段的 question_count 可能 <5,但只有笔试会调用本方法
        count = max(5, min(20, count))
        try:
            structured_llm = self.llm.with_structured_output(_WrittenExamQuestions)
            chain = WRITTEN_EXAM_GENERATOR_PROMPT | structured_llm
            result = chain.invoke(
                {
                    "question_count": count,
                    "company_name": self.result.company_name,
                    "job_title": self.result.job_title,
                    "match_analysis": self.result.match_analysis.model_dump_json(indent=2),
                    "business_scenarios": "\n\n".join(
                        s.model_dump_json(indent=2) for s in self.result.business_scenarios
                    ),
                    "risks": "\n\n".join(r.model_dump_json(indent=2) for r in self.result.risks),
                    "jd_profile": "",
                }
            )
            return result.questions[:count]
        except Exception:
            # 降级:从题库抽取
            return self.all_questions[:count]

    def submit_written_answers(self, answers: Dict[int, str]) -> dict:
        """提交笔试答案(批量),返回逐题评价 + 阶段总结.

        answers: {题目序号(0-based): 回答文本}
        """
        stage = self.stages[self.current_stage_index]
        if stage.stage_type != InterviewStageType.WRITTEN:
            raise RuntimeError("当前阶段不是笔试")
        questions = stage.written_questions
        if not questions:
            raise RuntimeError("笔试题目未生成")

        # 构建 turns(每题一个 turn)
        stage.turns = []
        qa_pairs_parts: List[str] = []
        for idx, q in enumerate(questions):
            ans = (answers.get(idx) or "").strip()
            turn = InterviewTurn(
                turn_index=len(self.turns) + idx + 1,
                question=q.question,
                answer=ans,
            )
            stage.turns.append(turn)
            self.turns.append(turn)
            qa_pairs_parts.append(
                f"第{idx + 1}题:\n题目: {q.question}\n参考答案: {q.reference_answer}\n候选人回答: {ans or '(未作答)'}"
            )

        # 批量评价
        try:
            structured_llm = self.llm.with_structured_output(_BatchEvaluation)
            chain = WRITTEN_BATCH_EVALUATE_PROMPT | structured_llm
            batch = chain.invoke(
                {
                    "company_name": self.result.company_name,
                    "job_title": self.result.job_title,
                    "count": len(questions),
                    "qa_pairs": "\n\n".join(qa_pairs_parts),
                }
            )
            for idx, eva in enumerate(batch.evaluations):
                if idx < len(stage.turns):
                    t = stage.turns[idx]
                    t.evaluation = eva.evaluation
                    t.score = eva.score
                    t.improvements = eva.improvements
                    t.evaluated = True
        except Exception as exc:
            for t in stage.turns:
                t.evaluation = f"评价生成失败: {exc}"
                t.score = 5
                t.evaluated = True

        # 阶段总结
        self._complete_current_stage()
        return {
            "turns": [t.model_dump() for t in stage.turns],
            "stage_score": stage.stage_score,
            "stage_summary": stage.stage_summary,
            "promotion_hint": stage.promotion_hint,
        }

    def _complete_current_stage(self) -> None:
        """完成当前阶段,生成阶段总结."""
        stage = self.stages[self.current_stage_index]
        stage_log = self._stage_history_text(stage)

        try:
            structured_llm = self.llm.with_structured_output(_StageSummary)
            chain = STAGE_SUMMARY_PROMPT | structured_llm
            summary = chain.invoke(
                {
                    "company_name": self.result.company_name,
                    "job_title": self.result.job_title,
                    "stage_name": stage.stage_name,
                    "stage_log": stage_log,
                }
            )
            stage.stage_score = summary.stage_score
            stage.stage_summary = summary.stage_summary
            stage.promotion_hint = summary.promotion_hint
        except Exception:
            # 降级:用平均分
            evaluated = [t for t in stage.turns if t.evaluated]
            avg = sum(t.score for t in evaluated) / max(1, len(evaluated)) * 10
            stage.stage_score = int(avg)
            stage.stage_summary = "阶段总结生成失败"
            if avg >= 70:
                stage.promotion_hint = "表现优秀,进入下一阶段"
            elif avg >= 50:
                stage.promotion_hint = "基本合格,继续努力"
            else:
                stage.promotion_hint = "表现不理想,真实场景可能被淘汰,但练习继续"

        stage.status = "completed"

    def advance_to_next_stage(self) -> str:
        """进入下一个阶段。返回值同 start_multi_stage 的 _enter_stage."""
        next_idx = self.current_stage_index + 1
        if next_idx >= len(self.stage_configs):
            return self._finish()
        return self._enter_stage(next_idx)

    @property
    def current_stage(self) -> Optional[InterviewStageTurn]:
        """当前阶段记录."""
        if not self.stages or self.current_stage_index >= len(self.stages):
            return None
        return self.stages[self.current_stage_index]

    @property
    def all_stages_completed(self) -> bool:
        """所有阶段是否都已完成."""
        return bool(self.stages) and all(s.status == "completed" for s in self.stages)

    # ── 单场流程控制(向后兼容,多阶段模式下路由到当前阶段)──

    def start(self) -> str:
        """生成第一道题,返回问题文本."""
        if self.is_multi_stage:
            return self.start_multi_stage()
        if not self.all_questions:
            # 题库为空,降级直接用 LLM 起手
            self.current_question = Question(
                title="开场",
                question="请简单做一个自我介绍,重点说说为什么适合这个岗位。",
                focus="沟通能力与岗位匹配度",
                reference_answer="",
            )
        else:
            first = self.all_questions[0]
            try:
                summary = self._analysis_summary()
                first_round_qs = "\n".join(
                    f"- {q.title}: {q.question}" for q in self.all_questions[:3]
                )
                chain = INTERVIEW_FIRST_QUESTION_PROMPT | self.llm
                resp = chain.invoke(
                    {
                        "company_name": self.result.company_name,
                        "job_title": self.result.job_title,
                        "analysis_summary": summary,
                        "first_round_questions": first_round_qs,
                    }
                )
                question_text = (
                    resp.content if hasattr(resp, "content") else str(resp)
                ).strip()
                self.current_question = Question(
                    title=first.title,
                    question=question_text or first.question,
                    focus=first.focus,
                    reference_answer=first.reference_answer,
                    direction=first.direction,
                )
            except Exception:
                self.current_question = self.all_questions[0]

        self.used_question_titles.append(self.current_question.title)
        turn = InterviewTurn(
            turn_index=1,
            question=self.current_question.question,
        )
        self.turns.append(turn)
        self.status = "answering"
        return self.current_question.question

    def submit_answer(self, answer: str) -> InterviewTurn:
        """提交候选人回答,生成即时评价,返回更新后的 turn."""
        if not self.current_question or not self.turns:
            raise RuntimeError("面试尚未开始,无法提交回答")
        if not answer.strip():
            raise ValueError("回答不能为空")

        current_turn = self.turns[-1]
        current_turn.answer = answer.strip()

        try:
            structured_llm = self.llm.with_structured_output(_AnswerEvaluation)
            chain = INTERVIEW_EVALUATE_PROMPT | structured_llm
            eva = chain.invoke(
                {
                    "company_name": self.result.company_name,
                    "job_title": self.result.job_title,
                    "question": self.current_question.question,
                    "focus": self.current_question.focus,
                    "reference_answer": self.current_question.reference_answer
                    or self.current_question.reference_hint
                    or "(无参考答案,请按回答完整度与深度评分)",
                    "answer": answer,
                }
            )
            current_turn.evaluation = eva.evaluation
            current_turn.score = eva.score
            current_turn.improvements = eva.improvements
        except Exception as exc:
            current_turn.evaluation = f"评价生成失败: {exc}"
            current_turn.score = 5
            current_turn.improvements = []

        current_turn.evaluated = True
        self.status = "evaluated"
        return current_turn

    def next_question(self) -> str:
        """生成下一道题."""
        if self.status != "evaluated":
            raise RuntimeError("请先提交并评价上一题的回答")

        # 多阶段模式:检查当前阶段是否达到题数上限
        if self.is_multi_stage:
            stage = self.current_stage
            if stage and self.stage_configs[self.current_stage_index].stage_type != InterviewStageType.WRITTEN:
                # 对话阶段:达到 max_turns 题则完成该阶段
                if len(stage.turns) >= max(1, self.max_turns):
                    self._complete_current_stage()
                    return "__STAGE_COMPLETED__"

        # 单场模式:达到最大轮次,结束面试
        if not self.is_multi_stage and len(self.turns) >= self.max_turns:
            return self._finish()

        remaining = [
            q for q in self.all_questions
            if q.title not in self.used_question_titles
        ]

        # 没有剩余题库,结束
        if not remaining and not self.turns:
            return self._finish()

        history = self._history_text()
        remaining_text = (
            "\n".join(f"- {q.title}: {q.question}" for q in remaining[:8])
            if remaining
            else "(题库已用完,可基于候选人薄弱点追问)"
        )

        try:
            chain = INTERVIEW_NEXT_QUESTION_PROMPT | self.llm
            resp = chain.invoke(
                {
                    "company_name": self.result.company_name,
                    "job_title": self.result.job_title,
                    "history": history,
                    "remaining_questions": remaining_text,
                }
            )
            question_text = (
                resp.content if hasattr(resp, "content") else str(resp)
            ).strip()
        except Exception:
            if remaining:
                question_text = remaining[0].question
            else:
                return self._finish()

        # 尝试匹配题库,以便拿到参考答案
        matched: Optional[Question] = None
        for q in remaining:
            if q.question in question_text or question_text in q.question:
                matched = q
                break
        if matched is None and remaining:
            matched = remaining[0]
        if matched is None:
            matched = Question(
                title="追问",
                question=question_text,
                focus="综合能力",
                reference_answer="",
            )
        else:
            matched = matched.model_copy(update={"question": question_text})

        self.current_question = matched
        self.used_question_titles.append(matched.title)
        next_turn = InterviewTurn(
            turn_index=len(self.turns) + 1,
            question=question_text,
        )
        self.turns.append(next_turn)
        # 多阶段:同步到当前阶段
        if self.is_multi_stage and self.current_stage:
            self.current_stage.turns.append(next_turn)
        self.status = "answering"
        return question_text

    def finish(self) -> InterviewReport:
        """主动结束面试,生成最终报告."""
        return self._finish()

    def _finish(self) -> str:
        """触发结束流程,返回提示文本."""
        self.status = "finished"
        return "__INTERVIEW_FINISHED__"

    def build_final_report(self) -> InterviewReport:
        """生成最终评估报告."""
        qa_log = self._history_text(full=True)
        try:
            structured_llm = self.llm.with_structured_output(_FinalReport)
            chain = INTERVIEW_FINAL_REPORT_PROMPT | structured_llm
            report_data = chain.invoke(
                {
                    "company_name": self.result.company_name,
                    "job_title": self.result.job_title,
                    "qa_log": qa_log,
                }
            )
        except Exception as exc:
            report_data = _FinalReport(
                overall_score=0,
                strengths=[],
                weak_areas=[],
                learning_suggestions=[],
                summary=f"报告生成失败: {exc}",
            )

        avg_score = (
            sum(t.score for t in self.turns if t.evaluated) / max(1, len([t for t in self.turns if t.evaluated]))
        ) * 10
        overall = report_data.overall_score or int(avg_score)

        self.status = "finished"
        self.report = InterviewReport(
            interview_id=self.id,
            analysis_id=self.analysis_id,
            company_name=self.result.company_name,
            job_title=self.result.job_title,
            overall_score=overall,
            rounds_completed=len(self.turns),
            turns=self.turns,
            strengths=report_data.strengths,
            weak_areas=report_data.weak_areas,
            learning_suggestions=report_data.learning_suggestions,
            summary=report_data.summary,
            created_at=_now(),
            stages=list(self.stages) if self.is_multi_stage else [],
            stages_completed=sum(1 for s in self.stages if s.status == "completed"),
        )
        return self.report

    # ── 辅助 ──

    def _analysis_summary(self) -> str:
        ma = self.result.match_analysis
        return (
            f"匹配度: {ma.match_score}/100\n"
            f"强项: {'; '.join(ma.strong_points[:3])}\n"
            f"弱项: {'; '.join(ma.weak_points[:3])}\n"
            f"风险: {'; '.join(r.risk_type for r in self.result.risks[:3])}"
        )

    def _history_text(self, full: bool = False) -> str:
        lines: List[str] = []
        for t in self.turns:
            lines.append(f"Q{t.turn_index}: {t.question}")
            if t.answer:
                lines.append(f"  A: {t.answer}")
            if full and t.evaluated:
                lines.append(f"  评价({t.score}/10): {t.evaluation}")
        return "\n".join(lines)

    def _stage_history_text(self, stage: InterviewStageTurn) -> str:
        """单阶段问答记录文本."""
        lines: List[str] = []
        for t in stage.turns:
            lines.append(f"Q{t.turn_index}: {t.question}")
            if t.answer:
                lines.append(f"  A: {t.answer}")
            if t.evaluated:
                lines.append(f"  评价({t.score}/10): {t.evaluation}")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "analysis_id": self.analysis_id,
            "status": self.status,
            "turns": [t.model_dump() for t in self.turns],
            "current_question": self.current_question.model_dump() if self.current_question else None,
            "used_question_titles": self.used_question_titles,
            "max_turns": self.max_turns,
            "result": self.result.model_dump(),
            "resume_text": self.resume_text,
            "created_at": self.created_at,
            "report": self.report.model_dump() if self.report else None,
            "stage_configs": [s.model_dump() for s in self.stage_configs],
            "stages": [s.model_dump() for s in self.stages],
            "current_stage_index": self.current_stage_index,
            "is_multi_stage": self.is_multi_stage,
        }

    @classmethod
    def from_dict(cls, data: dict, model_client: Optional[BaseChatModel] = None) -> "MockInterview":
        result = InterviewResult.model_validate(data["result"])
        stage_configs = [
            StageConfig.model_validate(s) for s in data.get("stage_configs", [])
        ]
        inst = cls(
            interview_id=data["id"],
            analysis_id=data.get("analysis_id", ""),
            result=result,
            resume_text=data.get("resume_text", ""),
            max_turns=data.get("max_turns", 8),
            model_client=model_client,
            stage_configs=stage_configs or None,
        )
        inst.status = data.get("status", "started")
        inst.turns = [InterviewTurn.model_validate(t) for t in data.get("turns", [])]
        inst.used_question_titles = data.get("used_question_titles", [])
        inst.created_at = data.get("created_at", _now())
        cq = data.get("current_question")
        inst.current_question = Question.model_validate(cq) if cq else None
        rpt = data.get("report")
        inst.report = InterviewReport.model_validate(rpt) if rpt else None
        inst.stages = [
            InterviewStageTurn.model_validate(s) for s in data.get("stages", [])
        ]
        inst.current_stage_index = data.get("current_stage_index", 0)
        inst.is_multi_stage = data.get("is_multi_stage", False)
        return inst


# ── 存储层 ──

class InterviewStore:
    """模拟面试会话存储."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, interview_id: str) -> Path:
        return self.root / f"{interview_id}.json"

    def save(self, interview: MockInterview) -> Path:
        path = self._path(interview.id)
        path.write_text(
            json.dumps(interview.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return path

    def load(
        self, interview_id: str, model_client: Optional[BaseChatModel] = None
    ) -> Optional[MockInterview]:
        path = self._path(interview_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return MockInterview.from_dict(data, model_client=model_client)
        except Exception:
            return None

    def list_all(self) -> List[dict]:
        items: List[dict] = []
        for p in sorted(self.root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                report = data.get("report") or {}
                items.append({
                    "id": data["id"],
                    "analysis_id": data.get("analysis_id", ""),
                    "status": data.get("status", ""),
                    "company_name": data.get("result", {}).get("company_name", ""),
                    "job_title": data.get("result", {}).get("job_title", ""),
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
        path = self._path(interview_id)
        if path.exists():
            path.unlink()
            return True
        return False


def new_interview(
    analysis_id: str,
    result: InterviewResult,
    resume_text: str = "",
    max_turns: int = 8,
    model_client: Optional[BaseChatModel] = None,
    stage_configs: Optional[List[StageConfig]] = None,
) -> MockInterview:
    """创建一场新的模拟面试(支持多阶段)."""
    return MockInterview(
        interview_id=f"iv-{uuid.uuid4().hex[:12]}",
        analysis_id=analysis_id,
        result=result,
        resume_text=resume_text,
        max_turns=max_turns,
        model_client=model_client,
        stage_configs=stage_configs,
    )
