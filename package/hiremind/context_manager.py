"""ContextManager：面试 Agent 的上下文提示词组装与预算控制."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Dict, Tuple

if TYPE_CHECKING:
    from .runtime import HireMindAgent

# 默认预算（字符数，非 token，粗略估算 1 字符 ≈ 0.5 token 中文 / 0.25 token 英文）
DEFAULT_TOTAL_BUDGET = 12000
DEFAULT_SECTION_BUDGETS = {
    "prefix": 2000,
    "memory": 1500,
    "interview_result": 2500,
    "history": 4500,
    "current_request": 1500,
}
DEFAULT_REDUCTION_ORDER = ["interview_result", "history", "memory", "prefix"]
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
- 如果需要调用工具，输出 JSON：{{"action": "tool", "name": "<tool_name>", "args": {{...}}}}
- 如果已经得到足够信息可以直接回答用户，输出：{{"action": "final", "answer": "<你的回答>"}}
- 如果信息不足需要用户补充，输出：{{"action": "retry", "message": "<需要什么信息>"}}
"""


class InterviewContextManager:
    """面试 Agent 的上下文组装器.

    按 section 预算组装 prompt，超预算时按 reduction_order 逐段压缩。
    current_request 永不裁剪。
    """

    def __init__(self, agent: "HireMindAgent"):
        self.agent = agent
        self.total_budget = DEFAULT_TOTAL_BUDGET
        self.section_budgets = dict(DEFAULT_SECTION_BUDGETS)
        self.reduction_order = list(DEFAULT_REDUCTION_ORDER)

    def build(self, user_message: str) -> Tuple[str, Dict]:
        """组装 prompt，返回 (prompt, metadata).

        metadata 记录每个 section 的 raw/budget/rendered 字符数，
        供 trace/report 解释 prompt 怎么被拼出来的。
        """
        sections = self._render_sections(user_message)
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

    def _render_sections(self, user_message: str) -> Dict[str, Dict]:
        """渲染各 section 文本."""
        # 1. 各 section 原始文本
        raw_texts = {
            "prefix": self._render_prefix(),
            "memory": self.agent.memory.render_memory_text(),
            "interview_result": self._render_interview_result(),
            "history": self._render_history(),
            "current_request": user_message,
        }

        sections = {}
        for name in ["prefix", "memory", "interview_result", "history", "current_request"]:
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

        # 2. 如果总长度超预算，按 reduction_order 压缩
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
        """渲染最近一次分析结果摘要."""
        result = self.agent.analysis.get("interview_result")
        if not result:
            return ""
        # 只保留关键字段的摘要
        lines = ["最近一次分析结果摘要："]
        if isinstance(result, dict):
            company = result.get("company_name", "")
            job = result.get("job_title", "")
            lines.append(f"公司：{company} | 岗位：{job}")
            match = result.get("match_analysis")
            if match:
                strong = match.get("strong_points", [])
                weak = match.get("weak_points", [])
                lines.append(f"强匹配：{', '.join(strong[:3])}")
                lines.append(f"弱项：{', '.join(weak[:3])}")
            questions = result.get("questions", {})
            if isinstance(questions, dict):
                total_q = sum(
                    len(v) for v in questions.values() if isinstance(v, list)
                )
                lines.append(f"已生成题目数：{total_q}")
        return "\n".join(lines)

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
        for name in ["prefix", "memory", "interview_result", "history", "current_request"]:
            text = sections[name]["text"]
            if text.strip():
                parts.append(text)
        return "\n\n---\n\n".join(parts)
