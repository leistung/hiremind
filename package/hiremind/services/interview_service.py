"""模拟面试服务：自适应提问、即时评价、最终报告."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from langchain_core.language_models.chat_models import BaseChatModel

from ..models.schemas import (
    InterviewReport,
    InterviewResult,
    InterviewTurn,
    Question,
)
from ..prompts import (
    INTERVIEW_EVALUATE_PROMPT,
    INTERVIEW_FINAL_REPORT_PROMPT,
    INTERVIEW_FIRST_QUESTION_PROMPT,
    INTERVIEW_NEXT_QUESTION_PROMPT,
)
from .llm_service import get_llm


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── 评价结构(LLM 结构化输出)──

from pydantic import BaseModel, Field


class _AnswerEvaluation(BaseModel):
    """单题评价结构."""

    evaluation: str = Field(default="", description="对该回答的即时评价,2-4 句话")
    score: int = Field(default=0, ge=0, le=10, description="本题得分 0-10")
    improvements: List[str] = Field(default_factory=list, description="改进建议,1-3 条")


class _FinalReport(BaseModel):
    """最终报告结构(不含元数据)."""

    overall_score: int = Field(default=0, ge=0, le=100)
    strengths: List[str] = Field(default_factory=list)
    weak_areas: List[str] = Field(default_factory=list)
    learning_suggestions: List[str] = Field(default_factory=list)
    summary: str = Field(default="")


# ── 模拟面试会话 ──

class MockInterview:
    """一场模拟面试的运行时状态.

    状态机:
        started → 第一题已出 → answer_pending → 用户回答 → evaluating → evaluated
              → next_question / finished

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
        self.report: Optional[InterviewReport] = None  # 结束后保存的最终报告

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

    # ── 流程控制 ──

    def start(self) -> str:
        """生成第一道题,返回问题文本."""
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

        # 达到最大轮次,结束面试
        if len(self.turns) >= self.max_turns:
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
        }

    @classmethod
    def from_dict(cls, data: dict, model_client: Optional[BaseChatModel] = None) -> "MockInterview":
        result = InterviewResult.model_validate(data["result"])
        inst = cls(
            interview_id=data["id"],
            analysis_id=data.get("analysis_id", ""),
            result=result,
            resume_text=data.get("resume_text", ""),
            max_turns=data.get("max_turns", 8),
            model_client=model_client,
        )
        inst.status = data.get("status", "started")
        inst.turns = [InterviewTurn.model_validate(t) for t in data.get("turns", [])]
        inst.used_question_titles = data.get("used_question_titles", [])
        inst.created_at = data.get("created_at", _now())
        cq = data.get("current_question")
        inst.current_question = Question.model_validate(cq) if cq else None
        rpt = data.get("report")
        inst.report = InterviewReport.model_validate(rpt) if rpt else None
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
) -> MockInterview:
    """创建一场新的模拟面试."""
    return MockInterview(
        interview_id=f"iv-{uuid.uuid4().hex[:12]}",
        analysis_id=analysis_id,
        result=result,
        resume_text=resume_text,
        max_turns=max_turns,
        model_client=model_client,
    )
