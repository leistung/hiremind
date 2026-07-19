"""简历解析节点."""

from ..models.schemas import InterviewState, ResumeProfile
from ..prompts import RESUME_PARSER_PROMPT
from ..services import get_llm


def parse_resume(state: InterviewState) -> dict:
    """解析简历，生成 ResumeProfile."""
    try:
        required_skills = []
        if state.jd_profile:
            required_skills = state.jd_profile.required_skills

        llm = get_llm()
        structured_llm = llm.with_structured_output(ResumeProfile)
        chain = RESUME_PARSER_PROMPT | structured_llm
        profile = chain.invoke(
            {
                "job_title": state.input.job_title,
                "required_skills": ", ".join(required_skills) if required_skills else "未提供",
                "resume": state.input.resume,
            }
        )
        return {"resume_profile": profile}
    except Exception as exc:  # pragma: no cover
        return {"error": f"简历解析失败: {exc}"}
