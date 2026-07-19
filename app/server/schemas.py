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


class ChatRequest(BaseModel):
    """对话请求."""

    message: str
    session_id: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None


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


class GenerateQuestionsRequest(BaseModel):
    """追加出题请求."""

    direction: str
    count: int = 2
    topic: str = ""


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

    session_id: str = ""
    max_turns: int = 8


class InterviewAnswerRequest(BaseModel):
    """提交回答."""

    answer: str


class InterviewListResponse(BaseModel):
    interviews: List[Dict[str, Any]]


# ── 历史记录 ──

class AnalysisHistoryItem(BaseModel):
    """面试分析历史项."""

    session_id: str
    title: str = ""
    company_name: str = ""
    job_title: str = ""
    match_score: int = 0
    rounds_count: int = 0
    created_at: str = ""
    updated_at: str = ""


class AnalysisHistoryResponse(BaseModel):
    items: List[AnalysisHistoryItem]


# ── 响应模型 ──

class AnalysisResponse(BaseModel):
    success: bool
    result: Optional[Dict[str, Any]] = None
    session_id: str
    error: Optional[str] = None


class ChatResponse(BaseModel):
    answer: str
    session_id: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class SessionSummary(BaseModel):
    id: str
    title: str = ""
    created_at: str = ""
    updated_at: str = ""
    message_count: int = 0
    metadata: Dict[str, Any] = {}


class SessionListResponse(BaseModel):
    sessions: List[SessionSummary]


class SessionDetailResponse(BaseModel):
    session: Dict[str, Any]


class ExportRequest(BaseModel):
    format: str  # word / pdf
    session_id: Optional[str] = None


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
