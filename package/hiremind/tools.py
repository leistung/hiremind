"""Tools：工具注册表与执行逻辑.

HireMind 的工具是面试分析动作（而非文件操作），
面向业务语义：分析、出题、召回、导出。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Callable, Dict, List

if TYPE_CHECKING:
    from .runtime import HireMindAgent

# ── 工具规格 ──

TOOL_SPECS: List[Dict[str, Any]] = [
    {
        "name": "run_analysis",
        "description": "执行完整面试分析（匹配度/场景/风险/五方向出题）",
        "schema": {
            "company_name": "str",
            "company_business_scope": "str",
            "job_title": "str",
            "job_requirements": "str",
            "resume": "str",
        },
        "risky": False,
    },
    {
        "name": "generate_more_questions",
        "description": "基于已有分析结果，针对指定方向再出 N 道题",
        "schema": {
            "direction": "str（简历深挖/业务场景/技术专业/行为文化/压力应变）",
            "count": "int",
            "topic": "str（可选，指定具体主题如 K8s、分布式锁）",
        },
        "risky": False,
    },
    {
        "name": "recall_memory",
        "description": "从持久记忆中召回相关历史信息（简历版本、岗位偏好、技能笔记）",
        "schema": {"query": "str"},
        "risky": False,
    },
    {
        "name": "export_report",
        "description": "导出最近一次分析报告为 Word 或 PDF",
        "schema": {"format": "str（word 或 pdf）"},
        "risky": False,
    },
    {
        "name": "save_to_workspace",
        "description": "把分析结果保存到工作区文件",
        "schema": {"filename": "str", "format": "str（json/md）"},
        "risky": True,
    },
]


# ── 参数校验 ──

def validate_tool(name: str, args: Dict[str, Any]) -> None:
    """通用参数校验，不合法则抛 ValueError."""
    spec = next((s for s in TOOL_SPECS if s["name"] == name), None)
    if spec is None:
        raise ValueError(f"未知工具: {name}")

    schema = spec.get("schema", {})
    # run_analysis 的 company_name / job_title / company_business_scope 可选
    optional_keys = {
        "run_analysis": {"company_name", "job_title", "company_business_scope"},
    }
    optional = optional_keys.get(name, set())
    for key, expected_type in schema.items():
        if key not in args:
            if key in optional:
                continue
            # generate_more_questions 的 topic 是可选的
            if name == "generate_more_questions" and key == "topic":
                continue
            raise ValueError(f"工具 {name} 缺少参数: {key}")


# ── 工具执行函数 ──

def tool_run_analysis(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """执行完整面试分析."""
    from .models.schemas import InterviewInput
    from .graph.interview_graph import InterviewGraph

    input_data = InterviewInput(
        company_name=args.get("company_name", "") or "",
        company_business_scope=args.get("company_business_scope", ""),
        job_title=args.get("job_title", "") or "",
        job_requirements=args["job_requirements"],
        resume=args["resume"],
    )

    graph = agent.graph
    result = graph.run(input_data)

    # 保存到 session
    agent.session["interview_result"] = result.model_dump()
    agent.session["title"] = f"{result.company_name}-{result.job_title}"
    agent.session["metadata"]["company_name"] = result.company_name
    agent.session["metadata"]["job_title"] = result.job_title
    # 立即落盘：直接调 run_full_analysis 时不会经过 _record_history/_finalize_run,
    # 需显式保存,否则历史记录页读取磁盘文件时 interview_result 仍为 None
    agent.session_store.save(agent.session)

    # 更新工作记忆
    agent.memory.set_current_result(result.model_dump())

    # 持久化简历版本
    try:
        agent.memory.save_resume_version(args["resume"])
        agent.memory.save_interview_summary(
            result.company_name, result.job_title,
            f"匹配度：强{len(result.match_analysis.strong_points)}/弱{len(result.match_analysis.weak_points)}/缺{len(result.match_analysis.not_mentioned)}",
        )
    except Exception:
        pass  # 持久化失败不影响主流程

    # 返回结构化摘要供 LLM 组织回答
    summary = {
        "company_name": result.company_name,
        "job_title": result.job_title,
        "match_analysis": {
            "strong_points": result.match_analysis.strong_points,
            "weak_points": result.match_analysis.weak_points,
            "not_mentioned": result.match_analysis.not_mentioned,
        },
        "business_scenarios": [
            {"scenario": s.scenario, "problem": s.inferred_problem}
            for s in result.business_scenarios
        ],
        "risks": [
            {"type": r.risk_type, "severity": r.severity, "description": r.description}
            for r in result.risks
        ],
        "questions_count": sum(
            len(qs) for qs in [
                result.questions.resume_deep_dive,
                result.questions.business_scenario,
                result.questions.technical_professional,
                result.questions.behavioral_cultural,
                result.questions.pressure_adaptability,
            ]
        ),
        "preparation_tips": result.preparation_tips,
    }
    return json.dumps(summary, ensure_ascii=False, indent=2)


def tool_generate_more_questions(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """基于已有分析结果追加出题."""
    from langchain_core.messages import HumanMessage, SystemMessage

    direction = args.get("direction", "技术专业")
    count = int(args.get("count", 2))
    topic = args.get("topic", "")

    result = agent.session.get("interview_result")
    if not result:
        return "错误：尚未进行过完整分析，请先调用 run_analysis。"

    system_prompt = f"""你是一名资深大厂面试官。请基于已有分析结果，在「{direction}」方向再出 {count} 道面试题。"""
    if topic:
        system_prompt += f" 题目需要围绕主题：{topic}。"
    system_prompt += "\n每道题包含：标题、题目、考察点、难度、参考提示。输出 JSON 数组。"

    context = json.dumps(result, ensure_ascii=False)[:3000]
    human_prompt = f"已有分析结果：\n{context}\n\n请出 {count} 道{direction}方向的题。"

    response = agent.model_client.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=human_prompt),
    ])

    return response.content if hasattr(response, "content") else str(response)


def tool_recall_memory(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """从持久记忆中召回相关信息."""
    query = args.get("query", "")
    candidates = agent.memory.recall_relevant(query, limit=5)

    # 也查找简历版本
    resumes = agent.memory.durable_store.list_resumes()

    if not candidates and not resumes:
        return "未找到相关记忆。"

    parts = []
    if candidates:
        parts.append("相关笔记：")
        for c in candidates:
            parts.append(f"  [{c['topic']}] {c['text']}")
    if resumes:
        parts.append(f"简历版本（共 {len(resumes)} 个）：")
        for r in resumes[:3]:
            parts.append(f"  - {r['version']}")

    return "\n".join(parts)


def tool_export_report(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """导出分析报告."""
    from .models.schemas import InterviewResult
    from .services.export_service import generate_pdf, generate_word

    result_data = agent.session.get("interview_result")
    if not result_data:
        return "错误：尚未进行过完整分析，无法导出。"

    result = InterviewResult.model_validate(result_data)
    fmt = args.get("format", "word").lower()

    if fmt in ("word", "docx"):
        file_bytes = generate_word(result)
        ext = "docx"
    elif fmt in ("pdf",):
        file_bytes = generate_pdf(result)
        ext = "pdf"
    else:
        return f"错误：不支持的格式 {fmt}，请选择 word 或 pdf。"

    safe_company = result.company_name.replace(" ", "_").replace("/", "_")
    safe_job = result.job_title.replace(" ", "_").replace("/", "_")
    filename = f"HireMind_{safe_company}_{safe_job}_面试分析.{ext}"

    agent.workspace.save_report(filename, file_bytes)

    return f"报告已导出：{filename}（{len(file_bytes)} bytes）"


def tool_save_to_workspace(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """把分析结果保存到工作区."""
    result_data = agent.session.get("interview_result")
    if not result_data:
        return "错误：尚未进行过完整分析。"

    filename = args.get("filename", "analysis.json")
    fmt = args.get("format", "json").lower()

    if fmt == "json":
        content = json.dumps(result_data, ensure_ascii=False, indent=2).encode("utf-8")
    elif fmt == "md":
        lines = [f"# 面试分析报告", ""]
        lines.append(f"公司：{result_data.get('company_name', '')}")
        lines.append(f"岗位：{result_data.get('job_title', '')}")
        match = result_data.get("match_analysis", {})
        lines.append(f"\n## 匹配度\n- 强匹配：{', '.join(match.get('strong_points', []))}")
        lines.append(f"- 弱项：{', '.join(match.get('weak_points', []))}")
        content = "\n".join(lines).encode("utf-8")
    else:
        return f"错误：不支持的格式 {fmt}"

    path = agent.workspace.reports_dir / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return f"已保存到工作区：{filename}（{len(content)} bytes）"


# ── 工具运行器映射 ──

_TOOL_RUNNERS: Dict[str, Callable] = {
    "run_analysis": tool_run_analysis,
    "generate_more_questions": tool_generate_more_questions,
    "recall_memory": tool_recall_memory,
    "export_report": tool_export_report,
    "save_to_workspace": tool_save_to_workspace,
}


def build_tool_registry(agent: "HireMindAgent") -> Dict[str, Callable]:
    """构建工具注册表，把 agent 绑定到每个执行函数."""
    import functools

    registry = {}
    for name, runner in _TOOL_RUNNERS.items():
        registry[name] = functools.partial(runner, agent)
    return registry
