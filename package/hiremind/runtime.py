"""Runtime：面试 Agent 运行时核心.

包在模型外面的控制循环：
组 prompt → 调模型 → 解析 → 执行工具 → 写 trace → 更新记忆 → 下一轮，
直到产出最终答案或命中停止条件。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from .context_manager import InterviewContextManager
from .graph.analysis_graph import AnalysisGraph
from .graph.interview_graph import InterviewFlowGraph
from .store.interview_store import InterviewStore, new_interview_state
from .memory import HireMindMemory
from .store.run_store import RunStore
from .store.analysis_store import AnalysisStore, new_analysis_state
from .models.schemas import (
    InterviewResult,
    InterviewStageType,
    StageConfig,
)
from .nodes.interview_nodes import DEFAULT_STAGE_CONFIGS
from .store.ask_store import AskState
from .tools import TOOL_SPECS, build_tool_registry, validate_tool
from .workspace import HireMindWorkspace

MAX_STEPS_DEFAULT = 6
MAX_RETRIES_DEFAULT = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class HireMindAgent:
    """面试 Agent 运行时.

    核心入口是 ask(user_message)：
    1. 创建 TaskState + start_run
    2. 组装 prompt（ContextManager）
    3. 调 LLM
    4. parse：tool / final / retry
    5. 若 tool → 执行 → 更新记忆 → 回到 2
    6. 若 final → 更新记忆 + 写 report + 返回
    7. 循环直到 final 或 step_limit
    """

    def __init__(
        self,
        model_client: BaseChatModel,
        workspace: HireMindWorkspace,
        analysis_store: AnalysisStore,
        run_store: RunStore,
        max_steps: int = MAX_STEPS_DEFAULT,
        max_retries: int = MAX_RETRIES_DEFAULT,
        analysis: Optional[Dict[str, Any]] = None,
    ):
        self.model_client = model_client
        self.workspace = workspace
        self.analysis_store = analysis_store
        self.run_store = run_store
        self.max_steps = max_steps
        self.max_retries = max_retries

        self.workspace.ensure_dirs()
        self.memory = HireMindMemory(workspace.root)
        self.context_manager = InterviewContextManager(self)
        # 两个独立工作流图:分析图(一次性 DAG)+ 模拟面试图(按 action 路由)
        self.analysis_graph = AnalysisGraph()
        self.interview_graph = InterviewFlowGraph()
        # 向后兼容:tools.py 等旧代码用 agent.graph 指代分析图
        self.graph = self.analysis_graph
        # 模拟面试会话存储
        self.interview_store = InterviewStore(workspace.interviews_dir)
        self.tools_spec = TOOL_SPECS
        self.tools = build_tool_registry(self)

        # 恢复或新建 analysis
        if analysis:
            self.analysis = analysis
        else:
            self.analysis = new_analysis_state()

        self.current_task_state: Optional[AskState] = None
        # ask 上下文:当前模拟面试状态(由 ask 路由按 interview_id 加载,仅供 context_manager 渲染)
        self.current_interview_state: Optional[Dict[str, Any]] = None
        self.last_prompt_metadata: Optional[Dict[str, Any]] = None

    # ── 核心入口 ──

    def ask(self, user_message: str, page_context: str = "") -> str:
        """执行一次完整 agent 回合.

        page_context: 前端传入的页面上下文(当前页面 + 业务状态摘要),
        注入 prompt 让 agent 知道用户在做什么。
        """
        # 1. 记 history + 创建 AskState
        self._record_history("user", user_message)
        task_state = AskState.create(user_message)
        self.current_task_state = task_state
        self.run_store.start_run(task_state)

        retries = 0

        # 2. 主循环
        while task_state.status == "running":
            if task_state.tool_steps >= self.max_steps:
                task_state.stop_step_limit()
                break
            if retries >= self.max_retries:
                task_state.stop_retry_limit()
                break

            # 组装 prompt
            prompt, metadata = self.context_manager.build(user_message, page_context)
            self.last_prompt_metadata = metadata
            task_state.record_attempt()
            self.run_store.append_trace(task_state, "prompt_built", metadata)

            # 调模型
            try:
                response = self.model_client.invoke([
                    SystemMessage(content="你是 HireMind 面试分析助手。"),
                    HumanMessage(content=prompt),
                ])
                raw_output = response.content if hasattr(response, "content") else str(response)
            except Exception as exc:
                task_state.stop_model_error(str(exc))
                self.run_store.append_trace(task_state, "model_error", {"error": str(exc)})
                break

            self.run_store.append_trace(task_state, "model_response", {
                "raw_output": raw_output[:1000],
            })

            # 3. 解析
            kind, payload = self._parse(raw_output)

            if kind == "tool":
                tool_name = payload.get("name", "")
                tool_args = payload.get("args", {})
                self.run_store.append_trace(task_state, "tool_called", {
                    "name": tool_name,
                    "args": tool_args,
                })
                tool_result = self.run_tool(tool_name, tool_args)
                self.run_store.append_trace(task_state, "tool_result", {
                    "name": tool_name,
                    "result": tool_result[:1000],
                })
                # 把工具结果作为新的 user 消息送入下一轮
                user_message = f"工具 {tool_name} 的执行结果：\n{tool_result}"
                self._record_history("tool", user_message)
                continue

            elif kind == "final":
                answer = payload.get("answer", raw_output)
                self._record_history("assistant", answer)
                task_state.finish_success(answer)
                self._finalize_run(task_state, answer)
                return answer

            elif kind == "retry":
                retries += 1
                retry_msg = payload.get("message", "需要更多信息")
                user_message = f"[系统提示：模型请求重试] {retry_msg}\n请重新处理用户的原始请求。"
                self.run_store.append_trace(task_state, "retry", {"message": retry_msg})
                continue

            else:
                # 无法解析，当作 final 直接返回原文
                self._record_history("assistant", raw_output)
                task_state.finish_success(raw_output)
                self._finalize_run(task_state, raw_output)
                return raw_output

        # 步数/重试上限
        fallback = task_state.final_answer or "抱歉，处理过程中达到了步数上限，请重试。"
        self._record_history("assistant", fallback)
        self._finalize_run(task_state, fallback)
        return fallback

    # ── 工具执行 ──

    def run_tool(self, name: str, args: Dict[str, Any]) -> str:
        """执行工具，带校验."""
        try:
            validate_tool(name, args)
        except ValueError as exc:
            return f"参数校验失败：{exc}"

        runner = self.tools.get(name)
        if runner is None:
            return f"未知工具：{name}"

        try:
            # current_task_state 仅在 ask() 流程中创建,
            # 直接调 run_tool / run_full_analysis 时为 None,容错跳过记录
            if self.current_task_state is not None:
                self.current_task_state.record_tool(name)
            result = runner(args)
            return result
        except Exception as exc:
            return f"工具执行出错：{type(exc).__name__}: {exc}"

    # ── 解析 ──

    def _parse(self, raw: str) -> tuple[str, Dict[str, Any]]:
        """解析模型输出为 tool / final / retry."""
        # 尝试提取 JSON
        json_str = self._extract_json(raw)
        if json_str:
            try:
                data = json.loads(json_str)
                action = data.get("action", "").lower()
                if action == "tool":
                    return "tool", {"name": data.get("name", ""), "args": data.get("args", {})}
                elif action == "final":
                    return "final", {"answer": data.get("answer", "")}
                elif action == "retry":
                    return "retry", {"message": data.get("message", "")}
            except json.JSONDecodeError:
                pass

        # 无法解析为结构化 JSON，当作 final 直接返回原文
        return "final", {"answer": raw}

    def _extract_json(self, text: str) -> Optional[str]:
        """从文本中提取 JSON 块."""
        # 尝试 ```json ... ``` 格式
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if match:
            return match.group(1)
        # 尝试直接找 { ... }
        match = re.search(r'\{[^{}]*"action"[^{}]*\}', text, re.DOTALL)
        if match:
            return match.group(0)
        # 尝试更宽泛的匹配
        start = text.find("{")
        if start != -1:
            depth = 0
            for i in range(start, len(text)):
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                    if depth == 0:
                        return text[start:i + 1]
        return None

    # ── 分析管理 ──

    def _record_history(self, role: str, content: str) -> None:
        """记录一条 history 并立即落盘."""
        self.analysis.setdefault("history", []).append({
            "role": role,
            "content": content,
            "timestamp": _now(),
        })
        self.analysis_store.save(self.analysis)

    def _finalize_run(self, task_state: AskState, answer: str) -> None:
        """收尾：写 task_state、report，保存分析."""
        self.run_store.write_task_state(task_state)
        self.run_store.write_report(task_state, {
            "status": task_state.status,
            "stop_reason": task_state.stop_reason,
            "tool_steps": task_state.tool_steps,
            "attempts": task_state.attempts,
            "final_answer": answer[:500],
        })
        self.run_store.append_trace(task_state, "run_finished", {
            "status": task_state.status,
        })
        self.analysis_store.save(self.analysis)

    def reset(self) -> None:
        """清空当前分析，开始新分析."""
        self.analysis = new_analysis_state()
        self.memory = HireMindMemory(self.workspace.root)
        self.current_task_state = None
        self.last_prompt_metadata = None

    @classmethod
    def from_analysis(
        cls,
        model_client: BaseChatModel,
        workspace: HireMindWorkspace,
        analysis_store: AnalysisStore,
        run_store: RunStore,
        analysis_id: str,
        **kwargs,
    ) -> "HireMindAgent":
        """从历史分析恢复 agent."""
        analysis = analysis_store.load(analysis_id)
        if not analysis:
            raise ValueError(f"Analysis not found: {analysis_id}")
        return cls(
            model_client=model_client,
            workspace=workspace,
            analysis_store=analysis_store,
            run_store=run_store,
            analysis=analysis,
            **kwargs,
        )

    # ── 便捷方法 ──

    def run_full_analysis(
        self,
        company_name: str,
        company_business_scope: str,
        job_title: str,
        job_requirements: str,
        resume: str,
    ) -> str:
        """直接执行完整分析（不经过 LLM 决策，直接调工具）.

        便捷方法，供不需要多轮对话的场景使用。
        """
        return self.run_tool("run_analysis", {
            "company_name": company_name,
            "company_business_scope": company_business_scope,
            "job_title": job_title,
            "job_requirements": job_requirements,
            "resume": resume,
        })

    # ── 模拟面试编排(图状态化:直接调 interview_graph,不再经过 MockInterview)──
    #
    # 这些方法是对外的面试入口:加载/创建 InterviewFlowState,
    # 调用 interview_graph.invoke 执行节点,持久化 state。
    # routes 的 interview 端点统一调用这些方法。

    def _resolve_analysis(self, analysis_id: str) -> Dict[str, Any]:
        """按 analysis_id 加载分析记录;与当前 agent 分析相同时直接返回内存副本."""
        if analysis_id and analysis_id != self.analysis.get("id"):
            analysis = self.analysis_store.load(analysis_id)
            if not analysis:
                raise ValueError(f"Analysis not found: {analysis_id}")
            return analysis
        return self.analysis

    def _load_interview_state(self, interview_id: str) -> Dict[str, Any]:
        """加载模拟面试 state."""
        state = self.interview_store.load(interview_id)
        if not state:
            raise ValueError(f"Interview not found: {interview_id}")
        return state

    def _save_interview_state(self, state: Dict[str, Any]) -> None:
        """持久化模拟面试 state."""
        self.interview_store.save(state.get("interview_id", ""), state)

    def recommend_interview_stages(
        self,
        analysis_id: str,
        expected_rounds: int = 4,
        company_business_scope: str = "",
        jd_summary: str = "",
    ) -> List[StageConfig]:
        """智能规划面试阶段方案(走 interview_graph 的 recommend_stages 节点)."""
        analysis = self._resolve_analysis(analysis_id)
        result_data = analysis.get("interview_result")
        if not result_data:
            raise ValueError("该分析尚未生成报告,请先在分析页生成报告")
        result = InterviewResult.model_validate(result_data)

        match_json = result.match_analysis.model_dump_json(indent=2)
        scenarios_json = "\n\n".join(
            s.model_dump_json(indent=2) for s in result.business_scenarios
        )
        risks_json = "\n\n".join(r.model_dump_json(indent=2) for r in result.risks)

        # 走 graph 的 recommend_stages 节点
        result_state = self.interview_graph.invoke({}, "recommend_stages", {
            "company_name": result.company_name,
            "job_title": result.job_title,
            "company_business_scope": company_business_scope,
            "jd_summary": jd_summary,
            "match_analysis": match_json,
            "business_scenarios": scenarios_json,
            "risks": risks_json,
            "expected_rounds": expected_rounds,
        })
        if result_state.get("error"):
            # 降级:默认配置裁剪到期望轮次
            return self._fallback_stage_configs(expected_rounds)

        out = result_state.get("output") or {}
        stages = out.get("stages")
        if not stages:
            return self._fallback_stage_configs(expected_rounds)

        configs: List[StageConfig] = []
        for item in stages:
            stage_type = InterviewStageType(item["stage_type"])
            qc = int(item.get("question_count", 10))
            if stage_type == InterviewStageType.WRITTEN:
                qc = max(5, min(20, qc))
            else:
                qc = max(1, min(9, qc))
            configs.append(StageConfig(
                stage_type=stage_type,
                stage_name=item.get("stage_name") or stage_type.value,
                question_count=qc,
                focus=item.get("focus", ""),
                rationale=item.get("rationale", ""),
            ))
        return configs if configs else self._fallback_stage_configs(expected_rounds)

    @staticmethod
    def _fallback_stage_configs(expected_rounds: int) -> List[StageConfig]:
        """LLM 失败时的降级方案:根据轮次数裁剪默认配置."""
        base = list(DEFAULT_STAGE_CONFIGS)
        if expected_rounds >= len(base):
            return base
        if expected_rounds <= 2:
            return [
                StageConfig(stage_type=InterviewStageType.TECH_1, stage_name="技术一面"),
                StageConfig(stage_type=InterviewStageType.HR, stage_name="人事面"),
            ]
        if expected_rounds == 3:
            return [
                StageConfig(stage_type=InterviewStageType.WRITTEN, stage_name="笔试", question_count=10),
                StageConfig(stage_type=InterviewStageType.TECH_1, stage_name="技术一面"),
                StageConfig(stage_type=InterviewStageType.HR, stage_name="人事面"),
            ]
        return base[:expected_rounds]

    def start_interview(
        self,
        analysis_id: str,
        max_turns: int = 8,
        stages: Optional[List[Dict[str, Any]]] = None,
    ) -> tuple:
        """启动一场模拟面试,返回 (state, output).

        output 包含 question_text(对话阶段)或 signal(笔试就绪)。
        """
        analysis = self._resolve_analysis(analysis_id)
        result_data = analysis.get("interview_result")
        if not result_data:
            raise ValueError("该分析尚未生成报告,请先在分析页生成报告")
        result = InterviewResult.model_validate(result_data)

        stage_configs: List[Dict[str, Any]] = []
        if stages:
            for s in stages:
                if not s.get("enabled", True):
                    continue
                stage_configs.append(StageConfig.model_validate(s).model_dump())

        state = new_interview_state(
            analysis_id=analysis.get("id", analysis_id),
            result=result,
            max_turns=max_turns,
            stage_configs=stage_configs or None,
        )
        state = self.interview_graph.invoke(state, "start")
        self._save_interview_state(state)
        return state, state.get("output") or {}

    def submit_interview_answer(self, interview_id: str, answer: str) -> tuple:
        """提交回答,返回 (state, output)."""
        state = self._load_interview_state(interview_id)
        state = self.interview_graph.invoke(state, "submit_answer", {"answer": answer})
        self._save_interview_state(state)
        return state, state.get("output") or {}

    def next_interview_question(self, interview_id: str) -> tuple:
        """生成下一题,返回 (state, output).

        output 可能包含:
        - question_text: 下一题文本
        - signal: __INTERVIEW_FINISHED__ / __STAGE_COMPLETED__
        """
        state = self._load_interview_state(interview_id)
        state = self.interview_graph.invoke(state, "next_question")
        self._save_interview_state(state)
        return state, state.get("output") or {}

    def submit_interview_written(self, interview_id: str, answers: Dict[int, str]) -> tuple:
        """笔试批量提交,返回 (state, output)."""
        state = self._load_interview_state(interview_id)
        state = self.interview_graph.invoke(state, "submit_written", {"answers": answers})
        self._save_interview_state(state)
        return state, state.get("output") or {}

    def advance_interview_stage(self, interview_id: str) -> tuple:
        """进入下一阶段,返回 (state, output)."""
        state = self._load_interview_state(interview_id)
        if not state.get("is_multi_stage"):
            raise ValueError("当前面试不是多阶段模式")
        state = self.interview_graph.invoke(state, "advance_stage")
        self._save_interview_state(state)
        return state, state.get("output") or {}

    def finish_interview(self, interview_id: str) -> tuple:
        """主动结束面试,生成最终报告,返回 (state, report_dict)."""
        state = self._load_interview_state(interview_id)
        state = self.interview_graph.invoke(state, "finish")
        self._save_interview_state(state)
        return state, state.get("report") or {}

    def abandon_interview(self, interview_id: str) -> Dict[str, Any]:
        """放弃面试(不生成报告)."""
        state = self._load_interview_state(interview_id)
        if state.get("status") not in ("finished", "abandoned"):
            state = self.interview_graph.invoke(state, "abandon")
            self._save_interview_state(state)
        return state

    def get_interview_state(self, interview_id: str) -> Dict[str, Any]:
        """获取模拟面试 state."""
        return self._load_interview_state(interview_id)

