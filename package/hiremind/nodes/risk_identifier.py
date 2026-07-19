"""风险点识别节点."""

from ..models.schemas import InterviewState, Risks
from ..prompts import RISK_IDENTIFIER_PROMPT
from ..services import get_llm


def identify_risks(state: InterviewState) -> dict:
    """识别履历风险点."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(Risks)
        chain = RISK_IDENTIFIER_PROMPT | structured_llm
        result = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "jd_profile": state.jd_profile.model_dump_json(indent=2) if state.jd_profile else "",
                "resume_profile": state.resume_profile.model_dump_json(indent=2)
                if state.resume_profile
                else "",
            }
        )
        return {"risks": result.risks}
    except Exception as exc:  # pragma: no cover
        return {"error": f"风险点识别失败: {exc}"}
