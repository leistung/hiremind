"""Pydantic 模型：定义 HireMind 的输入、输出与中间状态."""

from typing import Annotated, Any, Dict, List, Optional

from pydantic import BaseModel, Field


def _merge_errors(existing: Optional[str], new: Optional[str]) -> Optional[str]:
    """LangGraph reducer：合并多个并行节点可能产生的错误信息."""
    if not new:
        return existing
    if not existing:
        return new
    return f"{existing}\n{new}"


# ── 简历结构化模型 ──

class ResumeBasics(BaseModel):
    """简历基本信息."""

    name: str = Field(default="", description="姓名")
    phone: str = Field(default="", description="电话")
    email: str = Field(default="", description="邮箱")
    location: str = Field(default="", description="所在地")
    title: str = Field(default="", description="求职意向/当前职位")
    summary: str = Field(default="", description="个人简介/自我评价")
    photo: str = Field(default="", description="头像/职业照 URL,如 /api/assets/xxx.jpg")


class ResumeEducation(BaseModel):
    """教育经历."""

    school: str = Field(default="", description="学校")
    major: str = Field(default="", description="专业")
    degree: str = Field(default="", description="学历,如 本科/硕士")
    start: str = Field(default="", description="开始时间,如 2020-09")
    end: str = Field(default="", description="结束时间")
    gpa: str = Field(default="", description="GPA 或排名")
    description: str = Field(default="", description="补充说明")


class ResumeExperience(BaseModel):
    """工作经历."""

    company: str = Field(default="", description="公司")
    position: str = Field(default="", description="职位")
    start: str = Field(default="", description="开始时间")
    end: str = Field(default="", description="结束时间")
    description: str = Field(default="", description="工作内容/成果")


class ResumeProject(BaseModel):
    """项目经历."""

    name: str = Field(default="", description="项目名称")
    role: str = Field(default="", description="担任角色")
    start: str = Field(default="", description="开始时间")
    end: str = Field(default="", description="结束时间")
    description: str = Field(default="", description="项目描述/成果")
    tech_stack: List[str] = Field(default_factory=list, description="技术栈")


class ResumeSkill(BaseModel):
    """技能分组."""

    category: str = Field(default="", description="类别,如 编程语言/框架/工具")
    items: List[str] = Field(default_factory=list, description="具体技能")


class ResumeData(BaseModel):
    """结构化简历内容."""

    basics: ResumeBasics = Field(default_factory=ResumeBasics)
    education: List[ResumeEducation] = Field(default_factory=list)
    experiences: List[ResumeExperience] = Field(default_factory=list)
    projects: List[ResumeProject] = Field(default_factory=list)
    skills: List[ResumeSkill] = Field(default_factory=list)
    template: str = Field(default="classic", description="模板: classic/modern/minimal")


class Resume(BaseModel):
    """简历实体(含元数据)."""

    id: str
    name: str = Field(default="", description="简历名称,如 张三-后端工程师")
    data: ResumeData = Field(default_factory=ResumeData)
    raw_text: str = Field(default="", description="原始文本(上传解析的)")
    created_at: str = ""
    updated_at: str = ""


# ── 职位库模型 ──

class Position(BaseModel):
    """职位/JD 实体,供面试分析页快速选择."""

    id: str
    name: str = Field(default="", description="职位名称,如 字节-高级产品经理")
    company_name: str = Field(default="", description="公司名称,可选")
    company_business_scope: str = Field(default="", description="业务范围,可选")
    job_title: str = Field(default="", description="职位名称,可选")
    job_requirements: str = Field(default="", description="JD 正文,必填")
    notes: str = Field(default="", description="备注,如薪资/地点/优先级")
    created_at: str = ""
    updated_at: str = ""


# ── 面试分析模型 ──

class InterviewInput(BaseModel):
    """用户输入：公司、业务范围、岗位、JD、简历.

    company_name 与 job_title 可选(留空时使用默认占位符),
    job_requirements(JD 正文)与 resume 必填。
    """

    company_name: str = Field(default="", description="目标公司名称,可选")
    company_business_scope: str = Field(default="", description="公司业务范围/商业模式")
    job_title: str = Field(default="", description="目标岗位名称,可选")
    job_requirements: str = Field(..., description="岗位 JD / 岗位要求原文,必填")
    resume: str = Field(..., description="候选人简历原文,必填")


class JDProfile(BaseModel):
    """JD 解析后的结构化画像."""

    core_responsibilities: List[str] = Field(default_factory=list, description="核心职责")
    required_skills: List[str] = Field(default_factory=list, description="必要硬技能")
    bonus_skills: List[str] = Field(default_factory=list, description="加分技能")
    soft_skills: List[str] = Field(default_factory=list, description="软技能")
    business_background: str = Field(default="", description="业务背景/团队定位")
    hidden_focus: List[str] = Field(default_factory=list, description="隐藏考察点")
    culture_keywords: List[str] = Field(default_factory=list, description="公司/团队文化关键词")


class ResumeProfile(BaseModel):
    """简历解析后的结构化画像."""

    education: str = Field(default="", description="教育背景")
    total_years: str = Field(default="", description="工作年限")
    career_path: List[str] = Field(default_factory=list, description="职业轨迹")
    core_tech_stack: List[str] = Field(default_factory=list, description="核心技术栈")
    highlight_projects: List[dict] = Field(default_factory=list, description="亮点项目")
    quantified_achievements: List[str] = Field(default_factory=list, description="量化成果")
    potential_gaps: List[str] = Field(default_factory=list, description="与 JD 的潜在 Gap")


class MatchAnalysis(BaseModel):
    """匹配度分析：简历 vs 岗位."""

    match_score: int = Field(default=0, ge=0, le=100, description="整体匹配度评分 0-100")
    strong_points: List[str] = Field(default_factory=list, description="强匹配点")
    weak_points: List[str] = Field(default_factory=list, description="弱项/需补强")
    not_mentioned: List[str] = Field(default_factory=list, description="JD 要求但简历未提")
    improvement_points: List[str] = Field(
        default_factory=list, description="需要提升的改进点(可执行)"
    )


class BusinessScenario(BaseModel):
    """业务场景推演."""

    scenario: str = Field(..., description="业务场景名称")
    inferred_problem: str = Field(..., description="该岗位可能遇到的真实问题")
    interview_angle: str = Field(..., description="面试中可能的切入角度")


class Risk(BaseModel):
    """风险点识别."""

    risk_type: str = Field(..., description="风险类型,如 履历断层/技能空白/频繁跳槽")
    description: str = Field(..., description="具体描述")
    severity: str = Field(..., description="严重程度: 高/中/低")
    suggested_question: str = Field(..., description="针对该风险的建议面试题")


class Question(BaseModel):
    """单道面试题."""

    direction: str = Field(default="", description="题目方向,如 简历深挖/业务场景/技术/行为/压力")
    title: str = Field(..., description="题目标题")
    question: str = Field(..., description="题目内容")
    focus: str = Field(default="", description="考察点: 对应 JD 哪项要求/简历哪段经历")
    difficulty: str = Field(default="", description="难度星级,如 ⭐⭐⭐ 中等")
    rationale: str = Field(
        default="",
        description="出题分析: 为什么会出这道题,面试官想验证什么",
    )
    reference_answer: str = Field(
        default="",
        description="基于简历的参考答案: 候选人可以如何结合自身经历回答",
    )
    reference_hint: str = Field(default="", description="参考答案提示/回答方向(旧字段,兼容)")
    follow_ups: List[str] = Field(default_factory=list, description="追问方向")


class InterviewRound(BaseModel):
    """一轮面试题集合."""

    round_index: int = Field(..., description="第几轮, 从 1 开始")
    round_name: str = Field(..., description="轮次名称,如 第一轮·技术基础")
    round_focus: str = Field(default="", description="本轮重点考察方向")
    questions: List[Question] = Field(default_factory=list)


class InterviewQuestions(BaseModel):
    """面试题(按轮次组织,3-5 轮)."""

    rounds: List[InterviewRound] = Field(default_factory=list, description="面试轮次")
    # 向后兼容: 旧版按方向分组的字段(保留为空列表,不破坏旧导出)
    resume_deep_dive: List[Question] = Field(default_factory=list)
    business_scenario: List[Question] = Field(default_factory=list)
    technical_professional: List[Question] = Field(default_factory=list)
    behavioral_cultural: List[Question] = Field(default_factory=list)
    pressure_adaptability: List[Question] = Field(default_factory=list)


class InterviewResult(BaseModel):
    """完整面试分析结果."""

    company_name: str = Field(..., description="公司名称")
    job_title: str = Field(..., description="岗位名称")
    match_analysis: MatchAnalysis = Field(..., description="匹配度分析")
    business_scenarios: List[BusinessScenario] = Field(..., description="业务场景推演")
    risks: List[Risk] = Field(..., description="风险点识别")
    questions: InterviewQuestions = Field(..., description="面试题(按轮次)")
    preparation_tips: List[str] = Field(default_factory=list, description="备考建议")


# 用于结构化输出的包装模型
class BusinessScenarios(BaseModel):
    """业务场景列表包装."""

    scenarios: List[BusinessScenario] = Field(default_factory=list)


class Risks(BaseModel):
    """风险点列表包装."""

    risks: List[Risk] = Field(default_factory=list)


class PreparationTips(BaseModel):
    """备考建议列表包装."""

    tips: List[str] = Field(default_factory=list)


# LangGraph 状态模型
class InterviewState(BaseModel):
    """LangGraph 状态."""

    input: InterviewInput
    jd_profile: Optional[JDProfile] = None
    resume_profile: Optional[ResumeProfile] = None
    match_analysis: Optional[MatchAnalysis] = None
    business_scenarios: Optional[List[BusinessScenario]] = None
    risks: Optional[List[Risk]] = None
    questions: Optional[InterviewQuestions] = None
    preparation_tips: Optional[List[str]] = None
    error: Annotated[Optional[str], _merge_errors] = None


# ── 模拟面试模型 ──

class InterviewTurn(BaseModel):
    """一轮面试交互."""

    turn_index: int = Field(..., description="第几轮交互, 从 1 开始")
    question: str = Field(..., description="面试官提问")
    answer: str = Field(default="", description="候选人回答")
    evaluation: str = Field(default="", description="对该回答的即时评价")
    score: int = Field(default=0, ge=0, le=10, description="本题得分 0-10")
    improvements: List[str] = Field(default_factory=list, description="该题改进建议")
    evaluated: bool = Field(default=False, description="是否已评价")


class InterviewReport(BaseModel):
    """模拟面试最终报告."""

    interview_id: str
    session_id: str = Field(default="", description="关联的分析 session_id")
    company_name: str = ""
    job_title: str = ""
    overall_score: int = Field(default=0, ge=0, le=100, description="综合评分 0-100")
    rounds_completed: int = 0
    turns: List[InterviewTurn] = Field(default_factory=list)
    strengths: List[str] = Field(default_factory=list, description="表现好的地方")
    weak_areas: List[str] = Field(default_factory=list, description="掌握不好的地方")
    learning_suggestions: List[str] = Field(default_factory=list, description="学习建议")
    summary: str = Field(default="", description="总评")
    created_at: str = ""
