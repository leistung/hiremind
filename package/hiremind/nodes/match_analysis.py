"""匹配度分析节点."""

from ..models.schemas import InterviewState, MatchAnalysis
from ..prompts import MATCH_ANALYSIS_PROMPT
from ..services import get_llm


def analyze_match(state: InterviewState) -> dict:
    """对比 JD 与简历，生成 MatchAnalysis."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(MatchAnalysis)
        chain = MATCH_ANALYSIS_PROMPT | structured_llm
        analysis = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "jd_profile": state.jd_profile.model_dump_json(indent=2) if state.jd_profile else "",
                "resume_profile": state.resume_profile.model_dump_json(indent=2)
                if state.resume_profile
                else "",
            }
        )
        return {"match_analysis": analysis}
    except Exception as exc:  # pragma: no cover
        return {"error": f"匹配度分析失败: {exc}"}
