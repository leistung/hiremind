"""业务场景推演节点."""

from ..models.schemas import BusinessScenarios, InterviewState
from ..prompts import SCENARIO_BUILDER_PROMPT
from ..services import get_llm


def infer_scenarios(state: InterviewState) -> dict:
    """基于公司业务与 JD 推演业务场景."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(BusinessScenarios)
        chain = SCENARIO_BUILDER_PROMPT | structured_llm
        result = chain.invoke(
            {
                "company_name": state.input.company_name,
                "company_business_scope": state.input.company_business_scope,
                "job_title": state.input.job_title,
                "jd_profile": state.jd_profile.model_dump_json(indent=2)
                if state.jd_profile
                else "",
            }
        )
        return {"business_scenarios": result.scenarios}
    except Exception as exc:  # pragma: no cover
        return {"error": f"业务场景推演失败: {exc}"}
