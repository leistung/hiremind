"""LangGraph 工作流：JD + 简历 → 匹配度/业务场景/风险/五方向面试题."""

from langgraph.graph import END, START, StateGraph

from ..models.schemas import InterviewInput, InterviewResult, InterviewState
from ..nodes import (
    analyze_match,
    generate_preparation_tips,
    generate_questions,
    identify_risks,
    infer_scenarios,
    parse_jd,
    parse_resume,
)


class InterviewGraph:
    """面试分析工作流入口."""

    def __init__(self):
        self._graph = self._build_graph()

    @staticmethod
    def _build_graph():
        """构建 StateGraph."""
        builder = StateGraph(InterviewState)

        # 节点注册
        builder.add_node("parse_jd", parse_jd)
        builder.add_node("parse_resume", parse_resume)
        builder.add_node("analyze_match", analyze_match)
        builder.add_node("infer_scenarios", infer_scenarios)
        builder.add_node("identify_risks", identify_risks)
        builder.add_node("generate_questions", generate_questions)
        builder.add_node("generate_tips", generate_preparation_tips)

        # 边：START 同时解析 JD 和简历
        builder.add_edge(START, "parse_jd")
        builder.add_edge(START, "parse_resume")

        # 边：解析完成后并行执行三大分析
        for source in ("parse_jd", "parse_resume"):
            builder.add_edge(source, "analyze_match")
            builder.add_edge(source, "infer_scenarios")
            builder.add_edge(source, "identify_risks")

        # 边：三大分析完成后生成题目与建议
        for source in ("analyze_match", "infer_scenarios", "identify_risks"):
            builder.add_edge(source, "generate_questions")

        builder.add_edge("generate_questions", "generate_tips")
        builder.add_edge("generate_tips", END)

        return builder.compile()

    def run(self, input_data: InterviewInput) -> InterviewResult:
        """执行完整工作流并返回结果."""
        initial_state = InterviewState(input=input_data)
        final_state = self._graph.invoke(initial_state)

        if final_state.get("error"):
            raise RuntimeError(final_state["error"])

        return InterviewResult(
            company_name=input_data.company_name,
            job_title=input_data.job_title,
            match_analysis=final_state["match_analysis"],
            business_scenarios=final_state["business_scenarios"],
            risks=final_state["risks"],
            questions=final_state["questions"],
            preparation_tips=final_state.get("preparation_tips") or [],
        )
