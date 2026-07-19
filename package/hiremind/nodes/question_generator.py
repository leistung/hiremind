"""面试题生成与备考建议节点."""

from ..models.schemas import InterviewQuestions, InterviewState, PreparationTips
from ..prompts import QUESTION_GENERATOR_PROMPT, PREPARATION_TIPS_PROMPT
from ..services import get_llm


def generate_questions(state: InterviewState) -> dict:
    """生成按轮次组织的面试题(3-5 轮)."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(InterviewQuestions)
        chain = QUESTION_GENERATOR_PROMPT | structured_llm
        questions = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "company_business_scope": state.input.company_business_scope,
                "match_analysis": state.match_analysis.model_dump_json(indent=2)
                if state.match_analysis
                else "",
                "business_scenarios": "\n\n".join(
                    s.model_dump_json(indent=2) for s in (state.business_scenarios or [])
                ),
                "risks": "\n\n".join(r.model_dump_json(indent=2) for r in (state.risks or [])),
                "jd_profile": state.jd_profile.model_dump_json(indent=2) if state.jd_profile else "",
                "resume_profile": state.resume_profile.model_dump_json(indent=2)
                if state.resume_profile
                else "",
            }
        )
        return {"questions": questions}
    except Exception as exc:  # pragma: no cover
        return {"error": f"面试题生成失败: {exc}"}


def generate_preparation_tips(state: InterviewState) -> dict:
    """生成备考建议."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(PreparationTips)
        chain = PREPARATION_TIPS_PROMPT | structured_llm
        result = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "match_analysis": state.match_analysis.model_dump_json(indent=2)
                if state.match_analysis
                else "",
                "business_scenarios": "\n\n".join(
                    s.model_dump_json(indent=2) for s in (state.business_scenarios or [])
                ),
                "risks": "\n\n".join(r.model_dump_json(indent=2) for r in (state.risks or [])),
            }
        )
        return {"preparation_tips": result.tips}
    except Exception as exc:  # pragma: no cover
        return {"error": f"备考建议生成失败: {exc}"}
