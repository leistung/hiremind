"""Runtime：面试 Agent 运行时核心.

包在模型外面的控制循环：
组 prompt → 调模型 → 解析 → 执行工具 → 写 trace → 更新记忆 → 下一轮，
直到产出最终答案或命中停止条件。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from .context_manager import InterviewContextManager
from .graph.interview_graph import InterviewGraph
from .memory import HireMindMemory
from .run_store import RunStore
from .analysis_store import AnalysisStore, new_analysis
from .task_state import TaskState
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
        self.graph = InterviewGraph()
        self.tools_spec = TOOL_SPECS
        self.tools = build_tool_registry(self)

        # 恢复或新建 analysis
        if analysis:
            self.analysis = analysis
            # 恢复工作记忆
            mem_state = analysis.get("memory", {})
            if mem_state:
                self.memory.from_dict(mem_state)
        else:
            self.analysis = new_analysis()

        self.current_task_state: Optional[TaskState] = None
        self.last_prompt_metadata: Optional[Dict[str, Any]] = None

    # ── 核心入口 ──

    def ask(self, user_message: str) -> str:
        """执行一次完整 agent 回合."""
        # 1. 记 history + 创建 TaskState
        self._record_history("user", user_message)
        task_state = TaskState.create(user_message)
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
            prompt, metadata = self.context_manager.build(user_message)
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

    def _finalize_run(self, task_state: TaskState, answer: str) -> None:
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
        # 保存分析（含 memory）
        self.analysis["memory"] = self.memory.to_dict()
        self.analysis_store.save(self.analysis)

    def reset(self) -> None:
        """清空当前分析，开始新分析."""
        self.analysis = new_analysis()
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
