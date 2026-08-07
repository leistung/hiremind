"""ContextManager:ask 对话的上下文提示词组装与预算控制.

仅供 ask() 使用,不参与分析图/面试图执行。
从 agent.analysis 读取分析结果,从 agent.current_interview_state 读取模拟面试状态。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Dict, Tuple

if TYPE_CHECKING:
    from .runtime import HireMindAgent

# 默认预算（字符数，非 token，粗略估算 1 字符 ≈ 0.5 token 中文 / 0.25 token 英文）
DEFAULT_TOTAL_BUDGET = 12000
DEFAULT_SECTION_BUDGETS = {
    "prefix": 2000,
    "interview_result": 2500,
    "interview_state": 2000,
    "history": 4500,
    "current_request": 1500,
}
DEFAULT_REDUCTION_ORDER = ["interview_state", "interview_result", "history", "prefix"]
RECENT_WINDOW = 6  # history 保留最近 N 轮不压缩

AGENT_PREFIX = """你是 HireMind，一个专业的 AI 面试分析助手。

你的能力：
1. 分析岗位 JD 与候选人简历的匹配度
2. 推演公司业务场景下的真实面试题
3. 识别简历中的风险点（履历断层、技能空白等）
4. 生成五方向面试题（简历深挖/业务场景/技术专业/行为文化/压力应变）
5. 基于已有分析结果追加出题
6. 导出分析报告为 Word 或 PDF

你可以使用以下工具（用 JSON 格式调用）：
{tool_descriptions}

输出格式规则：
- 如果需要调用工具，输出 JSON（以 {{ 开头）：{{"action": "tool", "name": "<tool_name>", "args": {{...}}}}
- 如果信息不足需要用户补充，输出 JSON（以 {{ 开头）：{{"action": "retry", "message": "<需要什么信息>"}}
- 如果已经得到足够信息可以直接回答用户，直接输出纯文本回答（不要用 JSON 包裹，不要以 {{ 开头），这样可以流式显示给用户
"""


class InterviewContextManager:
    """ask 对话的上下文组装器.

    按 section 预算组装 prompt，超预算时按 reduction_order 逐段压缩。
    current_request 永不裁剪。
    """

    def __init__(self, agent: "HireMindAgent"):
        self.agent = agent
        self.total_budget = DEFAULT_TOTAL_BUDGET
        self.section_budgets = dict(DEFAULT_SECTION_BUDGETS)
        self.reduction_order = list(DEFAULT_REDUCTION_ORDER)

    def build(self, user_message: str, page_context: str = "") -> Tuple[str, Dict]:
        """组装 prompt，返回 (prompt, metadata).

        page_context: 前端传入的页面上下文(当前页面 + 业务状态),
        拼到 current_request 前让 agent 知道用户在做什么。
        """
        sections = self._render_sections(user_message, page_context)
        prompt = self._assemble_prompt(sections)
        metadata = {
            section: {
                "raw": info["raw_len"],
                "budget": info["budget"],
                "rendered": len(info["text"]),
            }
            for section, info in sections.items()
        }
        metadata["total_prompt_len"] = len(prompt)
        return prompt, metadata

    def _render_sections(self, user_message: str, page_context: str) -> Dict[str, Dict]:
        """渲染各 section 文本."""
        raw_texts = {
            "prefix": self._render_prefix(),
            "interview_result": self._render_interview_result(),
            "interview_state": self._render_interview_state(),
            "history": self._render_history(),
            "current_request": self._render_current_request(user_message, page_context),
        }

        sections = {}
        for name in ["prefix", "interview_result", "interview_state", "history", "current_request"]:
            raw = raw_texts[name]
            budget = self.section_budgets.get(name, 2000)
            if name == "current_request":
                # current_request 永不裁剪
                text = raw
            elif len(raw) <= budget:
                text = raw
            else:
                # 截断
                text = raw[:budget] + "\n...[已截断]"
            sections[name] = {
                "text": text,
                "raw_len": len(raw),
                "budget": budget,
            }

        # 如果总长度超预算，按 reduction_order 压缩
        total = sum(len(s["text"]) for s in sections.values())
        if total > self.total_budget:
            for section_name in self.reduction_order:
                if total <= self.total_budget:
                    break
                if section_name not in sections:
                    continue
                section = sections[section_name]
                if len(section["text"]) <= 200:
                    continue  # 已经很短，不再压缩
                old_len = len(section["text"])
                # 压缩到一半
                new_budget = max(200, section["budget"] // 2)
                section["text"] = section["text"][:new_budget] + "\n...[已压缩]"
                total -= (old_len - len(section["text"]))

        return sections

    def _render_prefix(self) -> str:
        """渲染 prefix：系统角色 + 工具列表."""
        tool_descs = []
        for spec in self.agent.tools_spec:
            args_str = ", ".join(
                f"{k}: {v}" for k, v in spec.get("schema", {}).items()
            )
            tool_descs.append(f"- {spec['name']}({args_str}): {spec['description']}")
        return AGENT_PREFIX.format(tool_descriptions="\n".join(tool_descs))

    def _render_interview_result(self) -> str:
        """渲染最近一次分析结果摘要(直接从 agent.analysis 读取)."""
        result = self.agent.analysis.get("interview_result")
        if not result:
            return ""
        lines = ["最近一次面试分析结果摘要："]
        if isinstance(result, dict):
            company = result.get("company_name", "")
            job = result.get("job_title", "")
            lines.append(f"公司：{company} | 岗位：{job}")
            match = result.get("match_analysis")
            if match:
                strong = match.get("strong_points", [])
                weak = match.get("weak_points", [])
                missing = match.get("not_mentioned", [])
                lines.append(f"强匹配({len(strong)})：{', '.join(strong[:5])}")
                lines.append(f"弱项({len(weak)})：{', '.join(weak[:5])}")
                lines.append(f"缺失({len(missing)})：{', '.join(missing[:5])}")
            scenarios = result.get("business_scenarios", [])
            if scenarios:
                lines.append(f"业务场景({len(scenarios)}个)：")
                for s in scenarios[:3]:
                    lines.append(f"  - {s.get('scenario', '')}: {s.get('inferred_problem', '')}")
            risks = result.get("risks", [])
            if risks:
                lines.append(f"风险点({len(risks)}个)：")
                for r in risks[:3]:
                    lines.append(f"  - [{r.get('risk_type', '')}/{r.get('severity', '')}] {r.get('description', '')}")
            questions = result.get("questions", {})
            if isinstance(questions, dict):
                q_lines = []
                for direction, qs in questions.items():
                    if isinstance(qs, list) and qs:
                        q_lines.append(f"  - {direction}: {len(qs)}题")
                if q_lines:
                    lines.append("五方向出题：" + "; ".join(q_lines).strip())
            tips = result.get("preparation_tips", [])
            if tips:
                lines.append(f"准备建议({len(tips)}条)")
        return "\n".join(lines)

    def _render_interview_state(self) -> str:
        """渲染当前模拟面试状态(从 agent.current_interview_state 读取)."""
        state = self.agent.current_interview_state
        if not state:
            return ""
        result = state.get("result") or {}
        company = result.get("company_name", "")
        job = result.get("job_title", "")
        status = state.get("status", "")
        lines = [f"当前模拟面试状态：{company} / {job}（状态：{status}）"]

        is_multi = state.get("is_multi_stage", False)
        stages = state.get("stages") or []
        stage_idx = state.get("current_stage_index", 0)
        if is_multi and stages:
            lines.append(f"多阶段面试，共 {len(stages)} 个阶段，当前第 {stage_idx + 1} 阶段：")
            for i, s in enumerate(stages):
                mark = "→" if i == stage_idx else ("✓" if s.get("status") == "completed" else "○")
                score = s.get("stage_score", 0)
                turns = len(s.get("turns") or [])
                lines.append(
                    f"  {mark} {s.get('stage_name', s.get('stage_type', ''))}"
                    f"（{s.get('status', '')}，{turns}题，得分{score}）"
                )
                # 笔试阶段显示题目
                if s.get("stage_type") == "written" and s.get("status") == "in_progress":
                    wqs = s.get("written_questions") or []
                    if wqs:
                        lines.append(f"    笔试题({len(wqs)}道)：")
                        for q in wqs[:5]:
                            lines.append(f"      - {q.get('title', '')}: {q.get('question', '')[:80]}")
        else:
            turns = state.get("turns") or []
            lines.append(f"单场面试，已完成 {len(turns)} 轮")

        current_q = state.get("current_question")
        if current_q:
            lines.append(f"当前题目：{current_q.get('question', '')[:100]}")
            if current_q.get("focus"):
                lines.append(f"  考察点：{current_q.get('focus', '')}")

        report = state.get("report")
        if report:
            lines.append(f"面试报告已生成，总分：{report.get('overall_score', 0)}")

        return "\n".join(lines)

    def _render_current_request(self, user_message: str, page_context: str) -> str:
        """渲染当前请求(含页面上下文)."""
        if page_context:
            return f"[页面上下文] {page_context}\n\n[用户提问] {user_message}"
        return user_message

    def _render_history(self) -> str:
        """渲染对话历史，保留 recent_window 轮，更老的压缩."""
        history = self.agent.analysis.get("history", [])
        if not history:
            return ""

        lines = []
        # 最近的 N 条保留原文
        recent = history[-(RECENT_WINDOW * 2):]  # *2 因为每轮有 user + assistant
        older = history[:-(RECENT_WINDOW * 2)] if len(history) > RECENT_WINDOW * 2 else []

        if older:
            lines.append(f"[更早的 {len(older)} 条对话已省略]")
        for item in recent:
            role = item.get("role", "")
            content = item.get("content", "")
            if role == "user":
                lines.append(f"用户: {content}")
            elif role == "assistant":
                lines.append(f"助手: {content}")
        return "\n".join(lines)

    def _assemble_prompt(self, sections: Dict[str, Dict]) -> str:
        """把各 section 文本拼成完整 prompt."""
        parts = []
        for name in ["prefix", "interview_result", "interview_state", "history", "current_request"]:
            text = sections[name]["text"]
            if text.strip():
                parts.append(text)
        return "\n\n---\n\n".join(parts)
