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
from .store.analysis_store import AnalysisStore, new_analysis_state
from .models.schemas import (
    InterviewResult,
    InterviewStageType,
    StageConfig,
)
from .nodes.interview_nodes import DEFAULT_STAGE_CONFIGS
from .store.ask_store import AskState, AskStore
from .store.position_store import PositionStore
from .store.resume_store import ResumeStore
from .tools import TOOL_SPECS, build_tool_registry, validate_tool
from .workspace import HireMindWorkspace

# ask() 控制循环的停止条件默认值:
# - max_steps:单次 ask 最多允许 LLM 调几次工具(防止无限循环)
# - max_retries:模型输出解析失败时最多重试几次(防止连续出错空转)
MAX_STEPS_DEFAULT = 6
MAX_RETRIES_DEFAULT = 3


def _now() -> str:
    # 统一使用 UTC ISO8601 时间戳,保证跨时区/跨机器可比较、可排序
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
        run_store: AskStore,
        max_steps: int = MAX_STEPS_DEFAULT,
        max_retries: int = MAX_RETRIES_DEFAULT,
        analysis: Optional[Dict[str, Any]] = None,
    ):
        self.model_client = model_client
        self.workspace = workspace
        self.analysis_store = analysis_store
        self.ask_store = run_store
        self.max_steps = max_steps
        self.max_retries = max_retries

        # 先确保 .hiremind/ 下 8 个子目录全部存在,后续落盘不依赖外部初始化
        self.workspace.ensure_dirs()
        # 分层记忆:工作区根目录下的 .hiremind/memory/,跨 analysis 持久存活
        self.memory = HireMindMemory(workspace.root)
        # 上下文组装器:仅供 ask() 使用,负责把分析结果/面试状态/历史拼进 prompt
        self.context_manager = InterviewContextManager(self)
        # 两个独立工作流图:分析图(一次性 DAG)+ 模拟面试图(按 action 路由)
        self.analysis_graph = AnalysisGraph()
        self.interview_graph = InterviewFlowGraph()
        # 向后兼容:tools.py 等旧代码用 agent.graph 指代分析图
        self.graph = self.analysis_graph
        # 模拟面试会话存储
        self.interview_store = InterviewStore(workspace.interviews_dir)
        # 简历/职位存储(供 ask 工具读取当前查看的简历/职位详情)
        self.resume_store = ResumeStore(workspace.resumes_dir)
        self.position_store = PositionStore(workspace.positions_dir)
        # 工具系统:specs 是声明式规格(LLM 可见),tools 是绑定 agent 的可执行注册表
        self.tools_spec = TOOL_SPECS
        self.tools = build_tool_registry(self)

        # 恢复或新建 analysis
        # 传入 analysis(历史记录)时直接复用,否则新建一份初始状态
        if analysis:
            self.analysis = analysis
        else:
            self.analysis = new_analysis_state()

        self.current_task_state: Optional[AskState] = None
        # ask 上下文:当前模拟面试状态(由 ask 路由按 interview_id 加载,仅供 context_manager 渲染)
        self.current_interview_state: Optional[Dict[str, Any]] = None
        self.last_prompt_metadata: Optional[Dict[str, Any]] = None
        # ask 上下文:暂存当前 page_context(供 read_position/read_resume 工具提取 ID)
        self._current_page_context: str = ""

    # ── 核心入口 ──

    def ask(self, user_message: str, page_context: str = "", on_token=None, on_status=None) -> str:
        """执行一次完整 agent 回合.

        page_context: 前端传入的页面上下文(当前页面 + 业务状态摘要),
        注入 prompt 让 agent 知道用户在做什么。
        on_token: 可选回调 (token: str) -> None,流式推送最终答案的每个 token。
        on_status: 可选回调 (status: str) -> None,推送阶段状态(如"正在调用工具")。
        """
        # 1. 记 history + 创建 AskState
        # 用户输入先落 history 并立即写盘,即使后续 LLM 失败也不丢上下文
        self._record_history("user", user_message)
        task_state = AskState.create(user_message)
        self.current_task_state = task_state
        # 暂存 page_context 供工具函数读取(如 read_position/read_resume 从中提取 ID)
        self._current_page_context = page_context
        self.ask_store.start_run(task_state)

        retries = 0

        # 2. 主循环
        # 循环不变量:每一轮要么执行一个工具(continue 回到顶部),
        # 要么产出 final 答案返回(break),直到命中停止条件。
        while task_state.status == "running":
            # 停止条件一:工具调用次数达到上限(防死循环)
            if task_state.tool_steps >= self.max_steps:
                task_state.stop_step_limit()
                break
            # 停止条件二:重试次数达到上限(防模型反复输出坏 JSON)
            if retries >= self.max_retries:
                task_state.stop_retry_limit()
                break

            # 组装 prompt
            # context_manager 按 5 个 section + 预算组装,并返回各段长度元数据用于审计
            prompt, metadata = self.context_manager.build(user_message, page_context)
            self.last_prompt_metadata = metadata
            task_state.record_attempt()
            self.ask_store.append_trace(task_state, "prompt_built", metadata)

            # 流式调模型:边接收边判断是否为纯文本答案
            # (纯文本直接流式推送;JSON 指令整体累积,不推送)
            try:
                raw_output = self._stream_model(prompt, on_token)
            except Exception as exc:
                # 模型调用失败:记录错误并终止本轮,把错误作为最终答案返回
                task_state.stop_model_error(str(exc))
                self.ask_store.append_trace(task_state, "model_error", {"error": str(exc)})
                break

            self.ask_store.append_trace(task_state, "model_response", {
                "raw_output": raw_output[:1000],
            })

            # 3. 解析
            # kind ∈ {tool, final, retry};纯文本会被 _parse 直接识别为 final
            kind, payload = self._parse(raw_output)

            if kind == "tool":
                # ── 工具分支:执行工具后把结果作为新的 user 消息送回模型 ──
                tool_name = payload.get("name", "")
                tool_args = payload.get("args", {})
                if on_status:
                    on_status(f"正在调用工具 {tool_name}…")
                self.ask_store.append_trace(task_state, "tool_called", {
                    "name": tool_name,
                    "args": tool_args,
                })
                tool_result = self.run_tool(tool_name, tool_args)
                self.ask_store.append_trace(task_state, "tool_result", {
                    "name": tool_name,
                    "result": tool_result[:1000],
                })
                # 把工具结果作为新的 user 消息送入下一轮
                # 这样模型"看到"的是对话形式的历史,无需维护单独的工具消息通道
                user_message = f"工具 {tool_name} 的执行结果：\n{tool_result}"
                self._record_history("tool", user_message)
                continue

            elif kind == "final":
                # ── final 分支:拿到最终答案,收尾并返回 ──
                answer = payload.get("answer", raw_output)
                self._record_history("assistant", answer)
                task_state.finish_success(answer)
                self._finalize_run(task_state, answer)
                return answer

            elif kind == "retry":
                # ── retry 分支:模型主动要求补充信息,重试次数 +1 ──
                retries += 1
                retry_msg = payload.get("message", "需要更多信息")
                user_message = f"[系统提示：模型请求重试] {retry_msg}\n请重新处理用户的原始请求。"
                self.ask_store.append_trace(task_state, "retry", {"message": retry_msg})
                continue

            else:
                # ── 无法解析分支:兜底当作 final,直接返回原文,不阻塞用户 ──
                self._record_history("assistant", raw_output)
                task_state.finish_success(raw_output)
                self._finalize_run(task_state, raw_output)
                return raw_output

        # 步数/重试上限
        # 命中停止条件时,若有部分答案则返回它,否则返回通用提示
        fallback = task_state.final_answer or "抱歉，处理过程中达到了步数上限，请重试。"
        self._record_history("assistant", fallback)
        self._finalize_run(task_state, fallback)
        return fallback

    def _stream_model(self, prompt: str, on_token=None) -> str:
        """流式调用模型,返回完整输出.

        策略:先缓冲前若干字符判断是 JSON(工具/重试) 还是纯文本答案。
        - 纯文本答案:边接收边通过 on_token 推送,实现逐字流式显示。
        - JSON:累积完整输出不推送(工具调用不需要显示给用户)。
        """
        raw_output = ""
        is_text_answer = False
        buffer = ""
        # 缓冲区大小:超过这么多字符且仍以 { 开头,认为是 JSON
        PROBE_LEN = 3

        for chunk in self.model_client.stream([
            SystemMessage(content="你是 HireMind 面试分析助手。"),
            HumanMessage(content=prompt),
        ]):
            chunk_text = chunk.content if hasattr(chunk, "content") else str(chunk)
            if not chunk_text:
                continue

            raw_output += chunk_text

            if not is_text_answer:
                buffer += chunk_text
                stripped = buffer.lstrip()
                if stripped and not stripped.startswith("{"):
                    # 纯文本答案:把已缓冲的内容推送出去,后续直接推送
                    is_text_answer = True
                    if on_token:
                        on_token(buffer)
                    buffer = ""
                # 如果以 { 开头,继续累积(可能是工具/重试 JSON)
            else:
                # 纯文本模式,直接推送每个 chunk
                if on_token:
                    on_token(chunk_text)

        return raw_output

    # ── 工具执行 ──

    def run_tool(self, name: str, args: Dict[str, Any]) -> str:
        """执行工具，带校验.

        这是 LLM 调工具与外部直接调工具(如 run_full_analysis)的统一入口:
        先做 schema 校验,再从注册表取执行器,异常统一转成字符串返回
        (LLM 友好,便于作为下一轮消息喂回模型)。
        """
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
        """解析模型输出为 tool / final / retry.

        新规则:纯文本(不以 { 开头)直接作为 final 答案;
        以 { 开头的才尝试解析为 JSON(tool/retry)。
        """
        stripped = raw.lstrip()
        # 不以 { 开头:纯文本答案
        if not stripped.startswith("{"):
            return "final", {"answer": raw}

        # 以 { 开头:尝试解析为 JSON
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

        # JSON 解析失败,当作 final 直接返回原文
        return "final", {"answer": raw}

    def _extract_json(self, text: str) -> Optional[str]:
        """从文本中提取 JSON 块(仅当文本以 { 开头时).

        支持两种格式:
        1. 代码块包裹:```json {...} ```,用正则直接提取;
        2. 裸 JSON:从第一个 { 开始,按花括号深度匹配到第一个完整闭合的 }。
        匹配失败返回 None,由 _parse 兜底按 final 处理。
        """
        stripped = text.lstrip()
        if not stripped.startswith("{"):
            return None
        # 尝试 ```json ... ``` 格式
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if match:
            return match.group(1)
        # 匹配第一个完整的 {...}
        # 逐个字符计数花括号深度,深度归零即找到一个完整闭合对象
        # (处理嵌套对象/数组,避免提前截断)
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
        self.ask_store.write_task_state(task_state)
        self.ask_store.write_report(task_state, {
            "status": task_state.status,
            "stop_reason": task_state.stop_reason,
            "tool_steps": task_state.tool_steps,
            "attempts": task_state.attempts,
            "final_answer": answer[:500],
        })
        self.ask_store.append_trace(task_state, "run_finished", {
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
        run_store: AskStore,
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
    #
    # 通用模式:load state → invoke(action) → save state → 返回 (state, output)
    # output 是节点产出的对前端有意义的结构(question_text / signal / report 等)。

    def _resolve_analysis(self, analysis_id: str) -> Dict[str, Any]:
        """按 analysis_id 加载分析记录;与当前 agent 分析相同时直接返回内存副本.

        面试编排可能针对"历史某次分析"发起,而 agent 内存里只有当前 analysis;
        这里保证:相同 ID 直接复用内存(避免重复读盘),不同 ID 从磁盘加载。
        """
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
        """智能规划面试阶段方案(走 interview_graph 的 recommend_stages 节点).

        流程:
        1. 加载分析记录并还原为 InterviewResult;
        2. 把匹配度/场景/风险以 JSON 形式作为 payload 交给 recommend_stages 节点;
        3. LLM 输出 StagePlan;失败或输出为空时降级到 _fallback_stage_configs。
        """
        analysis = self._resolve_analysis(analysis_id)
        result_data = analysis.get("interview_result")
        if not result_data:
            raise ValueError("该分析尚未生成报告,请先在分析页生成报告")
        result = InterviewResult.model_validate(result_data)

        # 结构化数据转 JSON 文本,作为 LLM 规划阶段的依据
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

        # 把 LLM 输出的原始 stage 字典规范化为 StageConfig:
        # 按阶段类型 clamp 题数(笔试 5-20,对话阶段 1-9),保证后续节点不会越界
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
        """LLM 失败时的降级方案:根据轮次数裁剪默认配置.

        兜底目标:即使阶段规划 LLM 完全不可用,面试也能按标准流程跑起来。
        - >= 4 轮:直接用默认 4 阶段(笔试/一面/二面/HR)
        - 3 轮:笔试 + 一面 + HR(去掉二面)
        - <= 2 轮:一面 + HR(去掉笔试,只保留核心对话环节)
        """
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

        流程:
        1. 加载分析记录,还原 InterviewResult(面试题的来源);
        2. 归一化阶段配置:过滤 disabled 阶段,统一转 StageConfig dict;
        3. 创建初始 InterviewFlowState(stages 非空 ⇒ 多阶段模式);
        4. 交给 start 节点执行,持久化后返回。

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
                # 前端可能传 enabled=false 表示跳过该阶段,这里直接过滤
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

