"""Tools：工具注册表与执行逻辑.

HireMind 的工具是面试分析动作（而非文件操作），
面向业务语义：分析、出题、召回、导出。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Dict, List

if TYPE_CHECKING:
    from .runtime import HireMindAgent


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_jsonable(obj: Any) -> Any:
    """把可能含 Pydantic 模型/枚举的对象转为 JSON 可序列化结构.

    优先使用 Pydantic 的 model_dump(),避免 default=str 产生 Python repr
    (如 "field='value'")导致前端难以解析。
    """
    # 递归处理 Pydantic 模型
    if hasattr(obj, "model_dump"):
        return _safe_jsonable(obj.model_dump())
    # 枚举
    if hasattr(obj, "value") and not isinstance(obj, type):
        return _safe_jsonable(obj.value)
    # 列表/元组
    if isinstance(obj, (list, tuple)):
        return [_safe_jsonable(item) for item in obj]
    # 字典
    if isinstance(obj, dict):
        return {k: _safe_jsonable(v) for k, v in obj.items()}
    # 基本类型直接返回
    if isinstance(obj, (str, int, float, bool, type(None))):
        return obj
    # 其他类型:尝试 JSON 序列化,失败则转 str
    try:
        json.dumps(obj, ensure_ascii=False)
        return obj
    except (TypeError, ValueError):
        return str(obj)

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
    {
        "name": "read_node_io",
        "description": "读取工作流节点的输入输出信息（分析图和模拟面试图的所有节点），用于回答用户关于分析/面试过程的提问",
        "schema": {
            "scope": "str（可选：analysis/interview/all，默认 all）",
            "node": "str（可选：指定节点名如 parse_jd/evaluate_answer，默认返回全部）",
            "analysis_id": "str（可选：指定分析记录 ID，默认用当前分析）",
            "interview_id": "str（可选：指定模拟面试 ID）",
        },
        "risky": False,
    },
    {
        "name": "read_position",
        "description": "读取职位库中某个职位的完整信息（JD 正文、公司、岗位等），用于回答用户关于当前查看职位的提问",
        "schema": {
            "position_id": "str（可选：职位 ID，默认读取 page_context 中正在查看的职位）",
        },
        "risky": False,
    },
    {
        "name": "read_resume",
        "description": "读取简历库中某份简历的完整信息（基本信息、教育、工作、项目、技能），用于回答用户关于当前查看简历的提问",
        "schema": {
            "resume_id": "str（可选：简历 ID，默认读取 page_context 中正在查看的简历）",
        },
        "risky": False,
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
        "read_node_io": {"scope", "node", "analysis_id", "interview_id"},
        "read_position": {"position_id"},
        "read_resume": {"resume_id"},
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

    input_data = InterviewInput(
        company_name=args.get("company_name", "") or "",
        company_business_scope=args.get("company_business_scope", ""),
        job_title=args.get("job_title", "") or "",
        job_requirements=args["job_requirements"],
        resume=args["resume"],
    )

    graph = agent.graph
    result = graph.run(input_data)

    # 保存到分析记录
    agent.analysis["interview_result"] = result.model_dump()
    agent.analysis["title"] = f"{result.company_name}-{result.job_title}"
    agent.analysis["metadata"]["company_name"] = result.company_name
    agent.analysis["metadata"]["job_title"] = result.job_title
    agent.analysis["status"] = "completed"
    agent.analysis["error"] = None
    # 立即落盘：直接调 run_full_analysis 时不会经过 _record_history/_finalize_run,
    # 需显式保存,否则历史记录页读取磁盘文件时 interview_result 仍为 None
    agent.analysis_store.save(agent.analysis)

    # 持久化简历版本到持久记忆(供 recall_memory 工具召回)
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


def run_analysis_with_progress(agent: "HireMindAgent", args: Dict[str, Any], on_progress=None) -> str:
    """流式执行面试分析,每完成一个节点回调 on_progress(node_name, label).

    on_progress 签名: (node_name: str, label: str) -> None
    """
    from .models.schemas import InterviewInput, InterviewResult

    input_data = InterviewInput(
        company_name=args.get("company_name", "") or "",
        company_business_scope=args.get("company_business_scope", ""),
        job_title=args.get("job_title", "") or "",
        job_requirements=args["job_requirements"],
        resume=args["resume"],
    )

    graph = agent.graph
    final_state = None
    node_io_records: List[Dict[str, Any]] = []
    # 流式执行:逐节点回调进度 + 记录 node_io
    try:
        for node_name, label, state, patch in graph.stream_run(input_data):
            if node_name != "done":
                node_io_records.append({
                    "node": node_name,
                    "label": label,
                    "output": _safe_jsonable(patch),
                    "ts": _now(),
                })
            # 实时同步 node_io 到 agent.analysis,供 _on_progress 落盘
            agent.analysis["node_io"] = node_io_records
            if on_progress:
                on_progress(node_name, label)
            if node_name == "done":
                final_state = state
    except Exception as exc:
        # stream_run 出错时保存已完成的 node_io,再向上抛出
        agent.analysis["node_io"] = node_io_records
        agent.analysis_store.save(agent.analysis)
        raise

    # 保存节点 IO 记录到分析 json,供 read_node_io 工具读取
    agent.analysis["node_io"] = node_io_records

    # 组装最终结果
    result = InterviewResult(
        company_name=input_data.company_name,
        job_title=input_data.job_title,
        match_analysis=final_state["match_analysis"],
        business_scenarios=final_state["business_scenarios"],
        risks=final_state["risks"],
        questions=final_state["questions"],
        preparation_tips=final_state.get("preparation_tips") or [],
    )

    # 保存到分析记录(与 tool_run_analysis 一致)
    agent.analysis["interview_result"] = result.model_dump()
    agent.analysis["title"] = f"{result.company_name}-{result.job_title}"
    agent.analysis["metadata"]["company_name"] = result.company_name
    agent.analysis["metadata"]["job_title"] = result.job_title
    agent.analysis["status"] = "completed"
    agent.analysis["error"] = None
    agent.analysis_store.save(agent.analysis)

    # 持久化简历版本到持久记忆(供 recall_memory 工具召回)
    try:
        agent.memory.save_resume_version(args["resume"])
        agent.memory.save_interview_summary(
            result.company_name, result.job_title,
            f"匹配度：强{len(result.match_analysis.strong_points)}/弱{len(result.match_analysis.weak_points)}/缺{len(result.match_analysis.not_mentioned)}",
        )
    except Exception:
        pass

    summary = {
        "company_name": result.company_name,
        "job_title": result.job_title,
        "match_analysis": {
            "strong_points": result.match_analysis.strong_points,
            "weak_points": result.match_analysis.weak_points,
            "not_mentioned": result.match_analysis.not_mentioned,
        },
        "questions_count": sum(
            len(qs) for qs in [
                result.questions.resume_deep_dive,
                result.questions.business_scenario,
                result.questions.technical_professional,
                result.questions.behavioral_cultural,
                result.questions.pressure_adaptability,
            ]
        ),
    }
    return json.dumps(summary, ensure_ascii=False, indent=2)


def tool_generate_more_questions(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """基于已有分析结果追加出题."""
    from langchain_core.messages import HumanMessage, SystemMessage

    direction = args.get("direction", "技术专业")
    count = int(args.get("count", 2))
    topic = args.get("topic", "")

    result = agent.analysis.get("interview_result")
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

    result_data = agent.analysis.get("interview_result")
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
    result_data = agent.analysis.get("interview_result")
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


def tool_read_node_io(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """读取工作流节点的输入输出信息(分析图 + 模拟面试图).

    始终从磁盘重新加载分析记录,确保读取到最新的 node_io(包括正在运行的分析)。
    当目标分析/面试仍在进行中时,返回"进行中"提示,让模型据实告知用户
    当前无法提供具体结果,但不影响回答与当前分析/面试无关的其他问题。
    """
    scope = args.get("scope", "all")
    node_filter = args.get("node", "")
    analysis_id = args.get("analysis_id", "") or agent.analysis.get("id", "")
    interview_id = args.get("interview_id", "")

    result: Dict[str, Any] = {}

    # ── 分析图节点 IO ──(始终从磁盘加载,获取最新数据)
    if scope in ("all", "analysis"):
        try:
            if analysis_id:
                analysis = agent.analysis_store.load(analysis_id)
            else:
                analysis = agent.analysis
            analysis = analysis or {}
            status = analysis.get("status", "completed")
            # 进行中(pending)时返回提示,避免模型基于不完整数据空转拼凑答案
            if status == "pending":
                completed_labels = [
                    r.get("label", r.get("node", ""))
                    for r in (analysis.get("node_io") or [])
                ]
                result["analysis_node_io"] = (
                    f"当前分析（{analysis_id}）正在进行中，尚未完成"
                    f"（已完成节点：{completed_labels or '暂无'}）。"
                    f"关于本次分析的匹配度/业务场景/风险/出题等具体结果暂时无法提供，"
                    f"请告知用户等待分析完成后再询问本次分析的结果。"
                    f"你可以正常回答与本次分析无关的其他问题。"
                )
            else:
                analysis_io = analysis.get("node_io", [])
                if node_filter:
                    analysis_io = [
                        r for r in analysis_io if r.get("node") == node_filter
                    ]
                result["analysis_node_io"] = analysis_io
        except Exception as exc:
            result["analysis_node_io"] = f"读取失败: {exc}"

    # ── 模拟面试图节点 IO ──
    if scope in ("all", "interview"):
        if interview_id:
            try:
                state = agent.interview_store.load(interview_id)
                if state:
                    iv_status = state.get("status", "")
                    # 面试进行中(started/answering,尚未产生评价)时返回提示;
                    # evaluated(阶段已评估)/finished/abandoned 正常返回数据
                    if iv_status in ("started", "answering"):
                        result["interview_node_io"] = (
                            f"当前模拟面试（{interview_id}）正在进行中，状态：{iv_status}，"
                            f"尚无评价/得分结果。关于本次面试的具体表现评价暂时无法提供，"
                            f"请告知用户完成当前阶段答题后再询问评价。"
                            f"你可以正常回答与本次面试无关的其他问题。"
                        )
                    else:
                        iv_io = state.get("node_io") or []
                        if node_filter:
                            filtered = []
                            for record in iv_io:
                                for action, data in record.items():
                                    if action == node_filter:
                                        filtered.append({action: data})
                            iv_io = filtered
                        result["interview_node_io"] = iv_io
                else:
                    result["interview_node_io"] = "模拟面试不存在"
            except Exception as exc:
                result["interview_node_io"] = f"读取失败: {exc}"
        else:
            result["interview_node_io"] = "未指定 interview_id,跳过"

    return json.dumps(result, ensure_ascii=False, indent=2, default=str)


def _extract_id_from_context(agent: "HireMindAgent", pattern: str) -> str:
    """从 page_context 字符串中正则提取 ID(如 position_id / resume_id)."""
    context = getattr(agent, "_current_page_context", "") or ""
    match = re.search(pattern, context)
    return match.group(1) if match else ""


def tool_read_position(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """读取职位库中某个职位的完整信息(JD 正文、公司、岗位等).

    优先用 args 里的 position_id,否则从 page_context 中提取当前查看的职位 ID。
    """
    position_id = args.get("position_id", "")
    if not position_id:
        # page_context 格式: "正在查看职位（ID: pos-xxx）"
        position_id = _extract_id_from_context(agent, r"正在查看职位（ID:\s*([^）]+)）")

    if not position_id:
        return json.dumps(
            {"error": "未指定 position_id,且无法从当前页面上下文中提取职位 ID。"
             "请告知用户先在职位库中选择一个职位,或在参数中提供 position_id。"},
            ensure_ascii=False,
        )

    try:
        position = agent.position_store.get(position_id)
        if position is None:
            return json.dumps(
                {"error": f"职位 {position_id} 不存在。"},
                ensure_ascii=False,
            )
        # 返回关键字段(JD 正文可能很长,完整返回供模型分析专业技能)
        return json.dumps(
            {
                "id": position.id,
                "name": position.name,
                "company_name": position.company_name,
                "company_business_scope": position.company_business_scope,
                "job_title": position.job_title,
                "job_requirements": position.job_requirements,
                "notes": position.notes,
                "created_at": position.created_at,
                "updated_at": position.updated_at,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    except Exception as exc:
        return json.dumps({"error": f"读取职位失败: {exc}"}, ensure_ascii=False)


def tool_read_resume(agent: "HireMindAgent", args: Dict[str, Any]) -> str:
    """读取简历库中某份简历的完整信息(基本信息、教育、工作、项目、技能).

    优先用 args 里的 resume_id,否则从 page_context 中提取当前查看的简历 ID。
    """
    resume_id = args.get("resume_id", "")
    if not resume_id:
        # page_context 格式: "正在查看简历（ID: resume-xxx）"
        resume_id = _extract_id_from_context(agent, r"正在查看简历（ID:\s*([^）]+)）")

    if not resume_id:
        return json.dumps(
            {"error": "未指定 resume_id,且无法从当前页面上下文中提取简历 ID。"
             "请告知用户先在简历管理中选择一份简历,或在参数中提供 resume_id。"},
            ensure_ascii=False,
        )

    try:
        resume = agent.resume_store.get(resume_id)
        if resume is None:
            return json.dumps(
                {"error": f"简历 {resume_id} 不存在。"},
                ensure_ascii=False,
            )
        # 返回完整简历数据供模型分析
        return json.dumps(
            {
                "id": resume.id,
                "name": resume.name,
                "data": resume.data,
                "raw_text": getattr(resume, "raw_text", "") or "",
                "created_at": resume.created_at,
                "updated_at": resume.updated_at,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    except Exception as exc:
        return json.dumps({"error": f"读取简历失败: {exc}"}, ensure_ascii=False)


# ── 工具运行器映射 ──

_TOOL_RUNNERS: Dict[str, Callable] = {
    "run_analysis": tool_run_analysis,
    "generate_more_questions": tool_generate_more_questions,
    "recall_memory": tool_recall_memory,
    "export_report": tool_export_report,
    "save_to_workspace": tool_save_to_workspace,
    "read_node_io": tool_read_node_io,
    "read_position": tool_read_position,
    "read_resume": tool_read_resume,
}


def build_tool_registry(agent: "HireMindAgent") -> Dict[str, Callable]:
    """构建工具注册表，把 agent 绑定到每个执行函数."""
    import functools

    registry = {}
    for name, runner in _TOOL_RUNNERS.items():
        registry[name] = functools.partial(runner, agent)
    return registry
