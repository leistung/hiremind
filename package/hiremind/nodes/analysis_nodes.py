"""面试分析工作流的 LLM 节点.

每个节点是纯函数:接收 AnalysisFlowState,调 LLM,返回 dict(patch)。
被 AnalysisGraph 注册为 LangGraph 节点,按 DAG 拓扑执行。

节点清单(按工作流顺序):
- parse_jd              解析岗位要求,生成 JDProfile
- parse_resume          解析简历,生成 ResumeProfile
- analyze_match         对比 JD 与简历,生成 MatchAnalysis
- infer_scenarios       推演业务场景
- identify_risks        识别履历风险点
- generate_questions    生成按轮次组织的面试题
- generate_preparation_tips  生成备考建议
"""

from __future__ import annotations

from ..models.schemas import (
    BusinessScenarios,
    InterviewQuestions,
    JDProfile,
    MatchAnalysis,
    PreparationTips,
    ResumeProfile,
    Risks,
)
from ..models.states import AnalysisFlowState
from ..prompts import (
    JD_PARSER_PROMPT,
    MATCH_ANALYSIS_PROMPT,
    PREPARATION_TIPS_PROMPT,
    QUESTION_GENERATOR_PROMPT,
    RESUME_PARSER_PROMPT,
    RISK_IDENTIFIER_PROMPT,
    SCENARIO_BUILDER_PROMPT,
)
from ..services import get_llm


# ── 节点中文标签(用于 node_io 记录与展示)──

NODE_LABELS = {
    "parse_jd": "解析岗位要求",
    "parse_resume": "解析简历",
    "analyze_match": "匹配度分析",
    "infer_scenarios": "推断业务场景",
    "identify_risks": "识别风险点",
    "generate_questions": "生成面试题",
    "generate_tips": "生成准备建议",
}


# ── 节点函数 ──
#
# 每个节点统一模式:
#   1. get_llm() 取模型,with_structured_output 绑定输出模型;
#   2. 用对应 Prompt | structured_llm 组成 LCEL chain;
#   3. invoke 前把 state 中的上游产物转成 JSON 文本(prompt 输入);
#   4. 成功返回 {"字段名": 结果} 的 patch;失败返回 {"error": ...},
#      由 AnalysisFlowState 的 _merge_errors reducer 聚合。


def parse_jd(state: AnalysisFlowState) -> dict:
    """解析 JD,生成 JDProfile.

    输入:state.input 的公司/岗位/业务范围/JD 原文;
    输出:jd_profile(供后续分析节点引用,包括 resume 解析所需的 required_skills)。
    """
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(JDProfile)
        chain = JD_PARSER_PROMPT | structured_llm
        profile = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "company_business_scope": state.input.company_business_scope,
                "job_requirements": state.input.job_requirements,
            }
        )
        return {"jd_profile": profile}
    except Exception as exc:  # pragma: no cover
        return {"error": f"JD 解析失败: {exc}"}


def parse_resume(state: AnalysisFlowState) -> dict:
    """解析简历,生成 ResumeProfile.

    依赖说明:若 jd_profile 已就绪则读取其 required_skills 作为
    简历解析的参考项(帮助 LLM 判断"JD 要什么、简历有什么"),
    未就绪时传"未提供"占位,不阻塞(与 parse_jd 并行,时序不保证)。

    防漏填:LLM 结构化输出偶发省略列表字段,简历足够长时若关键字段
    全部为空,用强化提示重试一次,显著降低空字段概率。
    """
    resume_text = (state.input.resume or "").strip()
    if not resume_text:
        return {"resume_profile": ResumeProfile(), "warning": "简历文本为空"}

    try:
        required_skills = []
        if state.jd_profile:
            required_skills = state.jd_profile.required_skills

        llm = get_llm()
        structured_llm = llm.with_structured_output(ResumeProfile)
        chain = RESUME_PARSER_PROMPT | structured_llm
        prompt_args = {
            "job_title": state.input.job_title,
            "required_skills": ", ".join(required_skills) if required_skills else "未提供",
            "resume": resume_text,
        }

        profile = chain.invoke(prompt_args)

        # 关键归纳字段:简历足够长却全部为空 → 疑似 LLM 漏填,重试一次
        key_fields = (
            "career_path",
            "core_tech_stack",
            "highlight_projects",
            "quantified_achievements",
            "potential_gaps",
        )
        if len(resume_text) >= 200 and not any(getattr(profile, f) for f in key_fields):
            profile = chain.invoke(prompt_args)

        return {"resume_profile": profile}
    except Exception as exc:  # pragma: no cover
        return {"error": f"简历解析失败: {exc}"}


def analyze_match(state: AnalysisFlowState) -> dict:
    """对比 JD 与简历,生成 MatchAnalysis."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(MatchAnalysis)
        chain = MATCH_ANALYSIS_PROMPT | structured_llm
        analysis = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "jd_profile": state.jd_profile.model_dump_json(indent=2) if state.jd_profile else "",
                "resume_profile": state.resume_profile.model_dump_json(indent=2)
                if state.resume_profile
                else "",
            }
        )
        return {"match_analysis": analysis}
    except Exception as exc:  # pragma: no cover
        return {"error": f"匹配度分析失败: {exc}"}


def infer_scenarios(state: AnalysisFlowState) -> dict:
    """基于公司业务与 JD 推演业务场景."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(BusinessScenarios)
        chain = SCENARIO_BUILDER_PROMPT | structured_llm
        result = chain.invoke(
            {
                "company_name": state.input.company_name,
                "company_business_scope": state.input.company_business_scope,
                "job_title": state.input.job_title,
                "jd_profile": state.jd_profile.model_dump_json(indent=2)
                if state.jd_profile
                else "",
            }
        )
        return {"business_scenarios": result.scenarios}
    except Exception as exc:  # pragma: no cover
        return {"error": f"业务场景推演失败: {exc}"}


def identify_risks(state: AnalysisFlowState) -> dict:
    """识别履历风险点."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(Risks)
        chain = RISK_IDENTIFIER_PROMPT | structured_llm
        result = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "jd_profile": state.jd_profile.model_dump_json(indent=2) if state.jd_profile else "",
                "resume_profile": state.resume_profile.model_dump_json(indent=2)
                if state.resume_profile
                else "",
            }
        )
        return {"risks": result.risks}
    except Exception as exc:  # pragma: no cover
        return {"error": f"风险点识别失败: {exc}"}


def generate_questions(state: AnalysisFlowState) -> dict:
    """生成按轮次组织的面试题(3-5 轮).

    收束节点:依赖 jd/resume 画像 + 匹配度 + 场景 + 风险 全部就绪,
    把所有中间产物以 JSON 文本拼进 prompt,让出题"贴简历、贴 JD"。
    """
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(InterviewQuestions)
        chain = QUESTION_GENERATOR_PROMPT | structured_llm
        questions = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "company_business_scope": state.input.company_business_scope,
                "match_analysis": state.match_analysis.model_dump_json(indent=2)
                if state.match_analysis
                else "",
                "business_scenarios": "\n\n".join(
                    s.model_dump_json(indent=2) for s in (state.business_scenarios or [])
                ),
                "risks": "\n\n".join(r.model_dump_json(indent=2) for r in (state.risks or [])),
                "jd_profile": state.jd_profile.model_dump_json(indent=2) if state.jd_profile else "",
                "resume_profile": state.resume_profile.model_dump_json(indent=2)
                if state.resume_profile
                else "",
            }
        )
        return {"questions": questions}
    except Exception as exc:  # pragma: no cover
        return {"error": f"面试题生成失败: {exc}"}


def generate_preparation_tips(state: AnalysisFlowState) -> dict:
    """生成备考建议."""
    try:
        llm = get_llm()
        structured_llm = llm.with_structured_output(PreparationTips)
        chain = PREPARATION_TIPS_PROMPT | structured_llm
        result = chain.invoke(
            {
                "company_name": state.input.company_name,
                "job_title": state.input.job_title,
                "match_analysis": state.match_analysis.model_dump_json(indent=2)
                if state.match_analysis
                else "",
                "business_scenarios": "\n\n".join(
                    s.model_dump_json(indent=2) for s in (state.business_scenarios or [])
                ),
                "risks": "\n\n".join(r.model_dump_json(indent=2) for r in (state.risks or [])),
            }
        )
        # LLM 返回结构化的 PreparationTip(含 level + content),
        # 这里拍平成 "【level】content" 字符串,保持下游 List[str] 契约不变
        return {
            "preparation_tips": [
                f"【{t.level}】{t.content}" if t.level else t.content
                for t in result.tips
            ]
        }
    except Exception as exc:  # pragma: no cover
        return {"error": f"备考建议生成失败: {exc}"}


# 节点注册表:节点名 → 节点函数(与 AnalysisGraph 内部注册保持一致)
# 存在意义:interview 侧 INTERVIEW_NODES 被 InterviewFlowGraph 直接消费;
# 分析侧 AnalysisGraph 内部显式注册,本表供需要"按名取节点"的场景使用。
ANALYSIS_NODES = {
    "parse_jd": parse_jd,
    "parse_resume": parse_resume,
    "analyze_match": analyze_match,
    "infer_scenarios": infer_scenarios,
    "identify_risks": identify_risks,
    "generate_questions": generate_questions,
    "generate_tips": generate_preparation_tips,
}
