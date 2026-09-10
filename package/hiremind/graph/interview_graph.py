"""模拟面试工作流图(InterviewFlowGraph)— 图状态化版本.

按 action 路由的 LangGraph:节点直接读写 InterviewFlowState,
状态在图内管理,由外层(HireMindAgent + InterviewStore)负责持久化。

用法:
    graph = InterviewFlowGraph()
    new_state = graph.invoke(state, "submit_answer", {"answer": "..."})

HireMindAgent 持有本图实例,编排方法直接调用 invoke。
node_io 记录每次执行的输入/输出,供 read_node_io 工具读取。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from langgraph.graph import END, START, StateGraph

from ..models.states import InterviewFlowState
from ..nodes.interview_nodes import INTERVIEW_NODES


def _route(state: InterviewFlowState) -> str:
    """条件边路由:按 action 返回目标节点名.

    LangGraph 的 add_conditional_edges 用本函数做分发,
    返回值必须落在 path_map 的键集合内(未知 action 由 invoke 提前拦截)。
    """
    return state.get("action", "")


class InterviewFlowGraph:
    """模拟面试工作流入口(图状态化).

    持有一个按 action 路由的 StateGraph,提供 invoke(state, action, payload) 方法。
    每次调用执行一个节点,返回更新后的完整 state。
    状态持久化由外层负责(InterviewStore),图本身不关心存储。

    与 AnalysisGraph 的区别:
    - AnalysisGraph 是一次性 DAG(一次 invoke 跑完整流水线);
    - 本图每次 invoke 只执行"一个动作",状态在多次调用间由外层保存/恢复。
    """

    def __init__(self):
        self._graph = self._build_graph()

    def _build_graph(self):
        builder = StateGraph(InterviewFlowState)

        # 注册所有节点(节点函数接收 state,返回 state patch)
        for name, fn in INTERVIEW_NODES.items():
            builder.add_node(name, fn)

        # START 按 action 路由到对应节点
        builder.add_conditional_edges(START, _route, path_map=list(INTERVIEW_NODES.keys()))
        # 每个节点执行完结束
        for name in INTERVIEW_NODES:
            builder.add_edge(name, END)

        return builder.compile()

    def invoke(
        self,
        state: Dict[str, Any],
        action: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """执行一个 action,返回更新后的完整 state.

        Args:
            state: 当前完整状态(从存储加载或新建)
            action: 要执行的动作(start/submit_answer/next_question/...)
            payload: 单次输入(如 {"answer": "..."} / {"answers": {...}})

        Returns:
            更新后的完整 state(调用方负责持久化)
        """
        if action not in INTERVIEW_NODES:
            return {**state, "error": f"未知 interview action: {action}"}

        # 组装单次执行状态:写入 action/payload,清空上轮的 output/error
        # (这样节点总能拿到"本次该做什么"的干净输入)
        input_state: InterviewFlowState = {
            **state,
            "action": action,
            "payload": payload or {},
            "output": None,
            "error": None,
        }
        result = self._graph.invoke(input_state)
        return dict(result)
