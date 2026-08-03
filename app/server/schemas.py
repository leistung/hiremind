"""API 请求/响应模型."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── 请求模型 ──

class AnalysisRequest(BaseModel):
    """表单分析请求.

    job_requirements(JD 正文)与 resume 必填,
    company_name 与 job_title 可选。
    """

    company_name: str = ""
    company_business_scope: str = ""
    job_title: str = ""
    job_requirements: str
    resume: str
    resume_id: Optional[str] = None


class ModelConfigRequest(BaseModel):
    """模型配置更新."""

    provider: str = "bailian"
    model: str = "qwen3.7-plus"
    api_key: str = ""
    base_url: str = ""


class ModelTestRequest(BaseModel):
    """模型连接测试请求."""

    model: str
    api_key: str = ""
    base_url: str = ""


class ModelTestResponse(BaseModel):
    """模型连接测试响应."""

    success: bool
    latency_ms: int = 0
    reply: str = ""
    error: str = ""


# ── 简历 ──

class ResumeBasicsIn(BaseModel):
    name: str = ""
    phone: str = ""
    email: str = ""
    location: str = ""
    title: str = ""
    summary: str = ""


class ResumeCreateRequest(BaseModel):
    """创建/更新简历."""

    name: str = ""
    data: Optional[Dict[str, Any]] = None
    raw_text: str = ""
    template: str = "classic"


class ResumeListResponse(BaseModel):
    resumes: List[Dict[str, Any]]


class ResumeParseRequest(BaseModel):
    """把文本解析为结构化简历."""

    text: str


class ResumeExportRequest(BaseModel):
    format: str = "word"  # word / pdf
    template: Optional[str] = None


# ── 职位库 ──

class PositionCreateRequest(BaseModel):
    """创建/更新职位."""

    name: str = ""
    company_name: str = ""
    company_business_scope: str = ""
    job_title: str = ""
    job_requirements: str = ""
    notes: str = ""


class PositionListResponse(BaseModel):
    positions: List[Dict[str, Any]]


# ── 模拟面试 ──

class InterviewStartRequest(BaseModel):
    """启动模拟面试."""

    analysis_id: str = ""
    max_turns: int = 8
    # 多阶段配置:空则用默认4阶段(笔试/技术一面/技术二面/人事面)
    stages: List[Dict[str, Any]] = []


class InterviewAnswerRequest(BaseModel):
    """提交回答."""

    answer: str


class WrittenAnswerRequest(BaseModel):
    """笔试批量提交回答."""

    answers: Dict[str, str] = Field(default_factory=dict, description="题目序号(0-based字符串):回答")


class InterviewListResponse(BaseModel):
    interviews: List[Dict[str, Any]]


# ── 历史记录 ──

class AnalysisHistoryResponse(BaseModel):
    """已废弃:旧版历史列表响应,保留供导出模块兼容."""
    items: List[Dict[str, Any]]


# ── 响应模型 ──

class AnalysisResponse(BaseModel):
    success: bool
    result: Optional[Dict[str, Any]] = None
    analysis_id: str
    error: Optional[str] = None
    model: str = ""


class AnalysisSummary(BaseModel):
    """分析列表摘要:含通用元信息与业务字段."""

    id: str
    title: str = ""
    status: str = "completed"
    company_name: str = ""
    job_title: str = ""
    match_score: int = 0
    rounds_count: int = 0
    message_count: int = 0
    created_at: str = ""
    updated_at: str = ""
    metadata: Dict[str, Any] = {}


class AnalysisListResponse(BaseModel):
    analyses: List[AnalysisSummary]


class AnalysisDetailResponse(BaseModel):
    """单条分析详情:含 status 与完整 interview_result."""

    success: bool = True
    analysis_id: str
    title: str = ""
    status: str = "completed"
    created_at: str = ""
    updated_at: str = ""
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    model: str = ""


class ExportRequest(BaseModel):
    format: str  # word / pdf
    analysis_id: Optional[str] = None


class ExportResponse(BaseModel):
    success: bool
    filename: Optional[str] = None
    error: Optional[str] = None


class ModelInfo(BaseModel):
    provider: str
    model: str
    api_key_configured: bool
    base_url: str = ""


class HealthResponse(BaseModel):
    status: str
    version: str
    workspace: str


class InterviewStateResponse(BaseModel):
    """模拟面试当前状态."""

    interview_id: str
    status: str
    current_question: Optional[str] = None
    turn_index: int = 0
    turns: List[Dict[str, Any]] = []
    finished: bool = False
    error: Optional[str] = None
