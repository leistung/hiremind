"""面试分析工作流图(AnalysisGraph).

LangGraph 工作流:JD + 简历 → 匹配度/业务场景/风险/五方向面试题。
节点函数统一维护在 hiremind.nodes.analysis_nodes。
"""

from typing import Iterator, Tuple

from langgraph.graph import END, START, StateGraph

from ..models.schemas import InterviewInput, InterviewResult
from ..models.states import AnalysisFlowState
from ..nodes.analysis_nodes import NODE_LABELS
from ..nodes import (
    analyze_match,
    generate_preparation_tips,
    generate_questions,
    identify_risks,
    infer_scenarios,
    parse_jd,
    parse_resume,
)


class AnalysisGraph:
    """面试分析工作流入口(JD+简历 → 匹配度/场景/风险/题目/建议)."""

    def __init__(self):
        self._graph = self._build_graph()

    @staticmethod
    def _build_graph():
        """构建 StateGraph."""
        builder = StateGraph(AnalysisFlowState)

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
        initial_state = AnalysisFlowState(input=input_data)
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

    def stream_run(self, input_data: InterviewInput) -> Iterator[Tuple[str, str, dict, dict]]:
        """流式执行工作流,逐节点 yield (node_name, label, state_dict, patch_dict) 进度.

        每完成一个节点,yield 一次。最后 yield ("done", "完成", final_state_dict, {})。
        patch_dict 是该节点的产出(已转为 JSON 可序列化 dict),供 node_io 记录。
        调用方可从 final_state_dict 组装 InterviewResult,无需二次 invoke。
        注意:返回的是 dict(而非 AnalysisFlowState 实例),因为 LangGraph 流式
        返回的 patch 是 dict,合并需要 dict 形式。
        """
        initial_state = AnalysisFlowState(input=input_data)
        # 用 dict 累积状态(AnalysisFlowState 是 BaseModel 不能用 ** 展开)
        final_state: dict = {"input": input_data}
        # stream_mode="updates":每个节点完成后 yield {node_name: state_patch}
        for chunk in self._graph.stream(initial_state, stream_mode="updates"):
            for node_name, patch in chunk.items():
                if node_name in NODE_LABELS:
                    # patch 可能是 dict 或 BaseModel,统一转 dict 合并
                    if isinstance(patch, dict):
                        patch_dict = patch
                    elif hasattr(patch, "model_dump"):
                        patch_dict = patch.model_dump()
                    else:
                        patch_dict = {"raw": str(patch)}
                    final_state.update(patch_dict)
                    yield (node_name, NODE_LABELS[node_name], final_state, patch_dict)

        if final_state.get("error"):
            raise RuntimeError(final_state["error"])

        yield ("done", "完成", final_state, {})


# 向后兼容:旧代码用 InterviewGraph 指代分析图
InterviewGraph = AnalysisGraph
