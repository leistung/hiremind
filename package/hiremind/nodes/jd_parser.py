"""JD 解析节点."""

from ..models.schemas import InterviewState, JDProfile
from ..prompts import JD_PARSER_PROMPT
from ..services import get_llm


def parse_jd(state: InterviewState) -> dict:
    """解析 JD，生成 JDProfile."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(JDProfile)
        chain = JD_PARSER_PROMPT | structured_llm
        profile = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "company_business_scope": state.input.company_business_scope,
                "job_requirements": state.input.job_requirements,
            }
        )
        return {"jd_profile": profile}
    except Exception as exc:  # pragma: no cover
        return {"error": f"JD 解析失败: {exc}"}
