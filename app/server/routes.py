"""API 路由：分析、对话、会话、导出、模型配置、简历、模拟面试."""

import tempfile
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from hiremind.models.schemas import InterviewResult, Position, ResumeData
from hiremind.services import (
    InterviewStore,
    MockInterview,
    PositionStore,
    ResumeStore,
    TEMPLATES,
    export_resume_pdf,
    export_resume_word,
    generate_pdf,
    generate_word,
    new_interview,
    parse_document,
    parse_resume_text_to_structured,
)
from hiremind.services.llm_service import get_llm

from .deps import (
    get_agent,
    get_interview_store,
    get_position_store,
    get_resume_store,
    get_workspace,
    reset_agent,
)
from .config import settings
from .schemas import (
    AnalysisRequest,
    AnalysisResponse,
    AnalysisHistoryItem,
    AnalysisHistoryResponse,
    ExportRequest,
    ExportResponse,
    HealthResponse,
    InterviewAnswerRequest,
    InterviewListResponse,
    InterviewStartRequest,
    InterviewStateResponse,
    ModelConfigRequest,
    ModelInfo,
    ModelTestRequest,
    ModelTestResponse,
    PositionCreateRequest,
    PositionListResponse,
    ResumeCreateRequest,
    ResumeExportRequest,
    ResumeListResponse,
    ResumeParseRequest,
    SessionDetailResponse,
    SessionListResponse,
    SessionSummary,
)

router = APIRouter()

BAILIAN_TEXT_MODELS = [
    "qwen-plus", "qwen-max", "qwen-turbo", "qwen-flash",
    "qwen3.6-plus", "qwen3.6-flash", "qwen3.5-plus", "qwen3.5-flash",
    "qwen-coder-plus", "deepseek-v3", "deepseek-r1", "qwq-32b",
    "llama3.3-70b-instruct",
]


# ── 健康检查 ──

@router.get("/health", response_model=HealthResponse, tags=["Health"])
async def health():
    return HealthResponse(
        status="ok",
        version="0.3.0",
        workspace=str(settings.workspace_root),
    )


# ── 模型配置 ──

@router.get("/models/info", response_model=ModelInfo, tags=["Models"])
async def get_model_info():
    return ModelInfo(
        provider=settings.default_provider,
        model=settings.model_name,
        api_key_configured=bool(settings.openai_api_key or settings.anthropic_api_key),
        base_url=settings.openai_base_url,
    )


@router.get("/models/bailian", tags=["Models"])
async def get_bailian_models():
    return {"models": BAILIAN_TEXT_MODELS}


@router.post("/models/config", tags=["Models"])
async def update_model_config(req: ModelConfigRequest):
    settings.apply_update(
        provider=req.provider,
        model=req.model,
        api_key=req.api_key,
        base_url=req.base_url,
    )
    reset_agent()
    return {"success": True, "model": settings.model_name}


@router.post("/models/test", response_model=ModelTestResponse, tags=["Models"])
def test_model_connection(req: ModelTestRequest):
    """测试模型连接是否可用.

    用提供的临时配置(model/api_key/base_url)构造一个 LLM 实例,
    发送一条最小 prompt("ping"),返回是否成功、延迟、回复内容。
    不影响当前已保存的全局配置。
    """
    if not req.model or not req.model.strip():
        return ModelTestResponse(success=False, error="请填写模型名称")
    try:
        # 用临时参数构造 LLM,不修改全局 settings
        llm = get_llm(
            model=req.model.strip(),
            api_key=req.api_key or None,
            base_url=req.base_url or None,
            temperature=0,
        )
        start = time.perf_counter()
        from langchain_core.messages import HumanMessage

        resp = llm.invoke([HumanMessage(content="ping")])
        latency = int((time.perf_counter() - start) * 1000)
        # 兼容不同返回类型
        reply = ""
        if hasattr(resp, "content"):
            reply = str(resp.content)
        else:
            reply = str(resp)
        return ModelTestResponse(
            success=True,
            latency_ms=latency,
            reply=reply[:200],
        )
    except Exception as exc:
        return ModelTestResponse(success=False, error=str(exc)[:300])


# ── 文档解析 ──

@router.post("/documents/parse", tags=["Documents"])
async def parse_document_api(file: UploadFile = File(...)):
    """上传 PDF / Word 文件，返回解析后的文本."""
    suffix = Path(file.filename or "").suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        text = parse_document(tmp_path)
        return {"success": True, "text": text, "filename": file.filename}
    except Exception as exc:
        return {"success": False, "error": str(exc), "filename": file.filename}
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ── 表单分析 ──

@router.post("/analysis/run", response_model=AnalysisResponse, tags=["Analysis"])
def run_analysis(req: AnalysisRequest):
    """直接执行完整分析.

    company_name 与 job_title 可选,留空时使用占位符。
    每次分析创建独立 session,避免覆盖历史记录。
    """
    try:
        agent = get_agent()
        # 重置 session：每次分析是独立会话,否则单例 agent 会复用同一 session,
        # 后续分析覆盖前一次的 interview_result,历史记录只剩最新一条
        agent.reset()
        # 兜底:空字符串转占位符,避免下游 prompt 出现"该公司"等空洞表述
        company_name = (req.company_name or "").strip() or "未指定公司"
        job_title = (req.job_title or "").strip() or "未指定岗位"
        agent.run_full_analysis(
            company_name=company_name,
            company_business_scope=req.company_business_scope or "",
            job_title=job_title,
            job_requirements=req.job_requirements,
            resume=req.resume,
        )
        result_data = agent.session.get("interview_result")
        return AnalysisResponse(
            success=True,
            result=result_data,
            session_id=agent.session["id"],
        )
    except Exception as exc:
        return AnalysisResponse(
            success=False,
            session_id="",
            error=str(exc),
        )


# ── 历史记录 ──

@router.get("/analysis/history", response_model=AnalysisHistoryResponse, tags=["Analysis"])
async def list_analysis_history():
    """列出所有生成过分析报告的会话摘要.

    遍历 sessions 目录,过滤出 interview_result 非空的会话,
    返回 session_id / title / company_name / job_title / match_score / rounds_count / 时间戳。
    """
    from hiremind import SessionStore
    ws = get_workspace()
    store = SessionStore(ws.sessions_dir)
    items: list[AnalysisHistoryItem] = []
    for path in sorted(ws.sessions_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            import json as _json
            data = _json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        result = data.get("interview_result")
        if not result:
            continue
        try:
            ma = result.get("match_analysis", {}) or {}
            rounds = (result.get("questions", {}) or {}).get("rounds", []) or []
            items.append(AnalysisHistoryItem(
                session_id=data.get("id", path.stem),
                title=data.get("title", "") or "",
                company_name=result.get("company_name", "") or "",
                job_title=result.get("job_title", "") or "",
                match_score=int(ma.get("match_score", 0) or 0),
                rounds_count=len(rounds),
                created_at=data.get("created_at", "") or "",
                updated_at=data.get("updated_at", "") or "",
            ))
        except Exception:
            continue
    return AnalysisHistoryResponse(items=items)


@router.get("/analysis/history/{session_id}", tags=["Analysis"])
async def get_analysis_history_detail(session_id: str):
    """读取指定会话的完整分析报告."""
    from hiremind import SessionStore
    ws = get_workspace()
    store = SessionStore(ws.sessions_dir)
    session = store.load(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    result = session.get("interview_result")
    if not result:
        raise HTTPException(status_code=404, detail="该会话无分析报告")
    return {
        "success": True,
        "session_id": session_id,
        "title": session.get("title", ""),
        "created_at": session.get("created_at", ""),
        "updated_at": session.get("updated_at", ""),
        "result": result,
    }


@router.get("/interview/{interview_id}/report", tags=["Interview"])
def get_interview_report(interview_id: str):
    """读取指定模拟面试的最终报告(含完整 turns)."""
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    # 若未生成报告但已结束,现场补生成
    if not iv.report and iv.status == "finished":
        try:
            iv.build_final_report()
            store.save(iv)
        except Exception:
            pass
    return {
        "success": True,
        "interview_id": interview_id,
        "status": iv.status,
        "company_name": iv.result.company_name,
        "job_title": iv.result.job_title,
        "turns": [t.model_dump() for t in iv.turns],
        "report": iv.report.model_dump() if iv.report else None,
    }


# ── 会话管理 ──

@router.get("/sessions", response_model=SessionListResponse, tags=["Sessions"])
async def list_sessions():
    from hiremind import SessionStore
    ws = get_workspace()
    store = SessionStore(ws.sessions_dir)
    sessions = store.list_all()
    return SessionListResponse(sessions=[SessionSummary(**s) for s in sessions])


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse, tags=["Sessions"])
async def get_session(session_id: str):
    from hiremind import SessionStore
    ws = get_workspace()
    store = SessionStore(ws.sessions_dir)
    session = store.load(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return SessionDetailResponse(session=session)


@router.delete("/sessions/{session_id}", tags=["Sessions"])
async def delete_session(session_id: str):
    from hiremind import SessionStore
    ws = get_workspace()
    store = SessionStore(ws.sessions_dir)
    deleted = store.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"success": True}


# ── 报告导出(分析报告)──

@router.post("/export", response_model=ExportResponse, tags=["Export"])
def export_report(req: ExportRequest):
    try:
        agent = get_agent()
        result_data = agent.session.get("interview_result")
        if not result_data:
            return ExportResponse(success=False, error="尚未进行过分析")
        result = InterviewResult.model_validate(result_data)
        fmt = req.format.lower()
        if fmt in ("word", "docx"):
            file_bytes = generate_word(result)
            ext = "docx"
        elif fmt == "pdf":
            file_bytes = generate_pdf(result)
            ext = "pdf"
        else:
            return ExportResponse(success=False, error=f"不支持的格式: {fmt}")
        safe_company = result.company_name.replace(" ", "_").replace("/", "_")
        safe_job = result.job_title.replace(" ", "_").replace("/", "_")
        filename = f"HireMind_{safe_company}_{safe_job}_面试分析.{ext}"
        ws = get_workspace()
        ws.save_report(filename, file_bytes)
        return ExportResponse(success=True, filename=filename)
    except Exception as exc:
        return ExportResponse(success=False, error=str(exc))


@router.get("/export/download/{filename}", tags=["Export"])
async def download_report(filename: str):
    ws = get_workspace()
    data = ws.get_report(filename)
    if data is None:
        raise HTTPException(status_code=404, detail="File not found")
    tmp = Path(tempfile.mktemp(suffix=Path(filename).suffix))
    tmp.write_bytes(data)
    media_type = (
        "application/pdf" if filename.endswith(".pdf")
        else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    return FileResponse(str(tmp), filename=filename, media_type=media_type)


@router.get("/export/list", tags=["Export"])
async def list_reports():
    ws = get_workspace()
    reports = ws.list_reports()
    return {"reports": [{"name": r.name, "size": r.stat().st_size} for r in reports]}


# ── 简历管理 ──

@router.get("/resumes/templates", tags=["Resumes"])
async def list_resume_templates():
    return {"templates": TEMPLATES}


@router.get("/resumes", response_model=ResumeListResponse, tags=["Resumes"])
async def list_resumes():
    store = get_resume_store()
    resumes = store.list_all()
    return ResumeListResponse(
        resumes=[
            {
                "id": r.id,
                "name": r.name,
                "template": r.data.template,
                "created_at": r.created_at,
                "updated_at": r.updated_at,
                "basics_name": r.data.basics.name,
                "basics_title": r.data.basics.title,
            }
            for r in resumes
        ]
    )


@router.post("/resumes", tags=["Resumes"])
async def create_resume(req: ResumeCreateRequest):
    store = get_resume_store()
    resume = store.create(name=req.name)
    if req.data:
        resume.data = ResumeData.model_validate(req.data)
    if req.raw_text:
        resume.raw_text = req.raw_text
    if req.template:
        resume.data.template = req.template
    store.save(resume)
    return {"success": True, "resume": resume.model_dump()}


@router.get("/resumes/{resume_id}", tags=["Resumes"])
async def get_resume(resume_id: str):
    store = get_resume_store()
    resume = store.get(resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    return {"success": True, "resume": resume.model_dump()}


@router.put("/resumes/{resume_id}", tags=["Resumes"])
async def update_resume(resume_id: str, req: ResumeCreateRequest):
    store = get_resume_store()
    resume = store.get(resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    if req.name:
        resume.name = req.name
    if req.data:
        resume.data = ResumeData.model_validate(req.data)
    if req.raw_text:
        resume.raw_text = req.raw_text
    if req.template:
        resume.data.template = req.template
    store.save(resume)
    return {"success": True, "resume": resume.model_dump()}


@router.delete("/resumes/{resume_id}", tags=["Resumes"])
async def delete_resume(resume_id: str):
    store = get_resume_store()
    deleted = store.delete(resume_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Resume not found")
    return {"success": True}


@router.post("/resumes/parse-text", tags=["Resumes"])
def parse_resume_text(req: ResumeParseRequest):
    """把文本解析为结构化简历."""
    try:
        data = parse_resume_text_to_structured(req.text)
        return {"success": True, "data": data.model_dump()}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/resumes/upload-parse", tags=["Resumes"])
async def upload_and_parse_resume(file: UploadFile = File(...)):
    """上传文件并解析为结构化简历(文本提取 + LLM 结构化).

    保持 async 以读取 UploadFile,LLM 调用放到线程池避免阻塞事件循环。
    """
    import asyncio
    suffix = Path(file.filename or "").suffix
    content = await file.read()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        text = parse_document(tmp_path)
        # LLM 结构化较慢(1-5 分钟),放到线程池避免阻塞事件循环
        data = await asyncio.to_thread(parse_resume_text_to_structured, text)
        return {
            "success": True,
            "text": text,
            "data": data.model_dump(),
            "filename": file.filename,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc), "filename": file.filename}
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@router.post("/resumes/{resume_id}/export", tags=["Resumes"])
def export_resume(resume_id: str, req: ResumeExportRequest):
    """导出简历为 Word/PDF."""
    store = get_resume_store()
    resume = store.get(resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")
    if req.template:
        resume.data.template = req.template
    try:
        fmt = req.format.lower()
        if fmt in ("word", "docx"):
            file_bytes = export_resume_word(resume)
            ext = "docx"
        elif fmt == "pdf":
            file_bytes = export_resume_pdf(resume)
            ext = "pdf"
        else:
            return {"success": False, "error": f"不支持的格式: {fmt}"}
        safe_name = (resume.data.basics.name or resume.name).replace(" ", "_").replace("/", "_")
        filename = f"简历_{safe_name}.{ext}"
        ws = get_workspace()
        ws.save_report(filename, file_bytes)
        return {"success": True, "filename": filename}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ── 图片上传与资源服务 ──

ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
IMAGE_MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


@router.post("/resumes/{resume_id}/photo", tags=["Resumes"])
async def upload_resume_photo(resume_id: str, file: UploadFile = File(...)):
    """上传简历头像/职业照,返回可访问的 URL。

    图片存到 .hiremind/assets/,返回 /api/assets/<filename> 形式的 URL。
    同时把 URL 写入 resume.data.basics.photo。
    """
    store = get_resume_store()
    resume = store.get(resume_id)
    if not resume:
        raise HTTPException(status_code=404, detail="Resume not found")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_IMAGE_EXTS:
        return {
            "success": False,
            "error": f"不支持的图片格式,仅支持 {', '.join(ALLOWED_IMAGE_EXTS)}",
        }

    data = await file.read()
    if not data:
        return {"success": False, "error": "图片内容为空"}

    # 限制 5MB
    if len(data) > 5 * 1024 * 1024:
        return {"success": False, "error": "图片过大,请上传 5MB 以内的图片"}

    ws = get_workspace()
    # 用 resume_id + 随机后缀作为文件名,避免冲突
    asset_name = f"{resume_id}_{uuid.uuid4().hex[:8]}{suffix}"
    ws.save_asset(asset_name, data)

    photo_url = f"/api/assets/{asset_name}"
    resume.data.basics.photo = photo_url
    store.save(resume)

    return {"success": True, "photo": photo_url}


@router.get("/assets/{filename}", tags=["Assets"])
async def serve_asset(filename: str):
    """提供上传资源文件(图片)的访问."""
    # 防止路径穿越
    safe = Path(filename).name
    if safe != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    ws = get_workspace()
    path = ws.get_asset_path(safe)
    if not path:
        raise HTTPException(status_code=404, detail="Asset not found")
    suffix = Path(safe).suffix.lower()
    media_type = IMAGE_MEDIA_TYPES.get(suffix, "application/octet-stream")
    return FileResponse(str(path), media_type=media_type)


# ── 职位库管理 ──

@router.get("/positions", response_model=PositionListResponse, tags=["Positions"])
async def list_positions():
    """列出所有保存的职位."""
    store = get_position_store()
    items = store.list_all()
    return {"positions": [p.model_dump() for p in items]}


@router.post("/positions", tags=["Positions"])
async def create_position(req: PositionCreateRequest):
    """新建职位."""
    store = get_position_store()
    position = store.create(
        name=req.name,
        company_name=req.company_name,
        company_business_scope=req.company_business_scope,
        job_title=req.job_title,
        job_requirements=req.job_requirements,
        notes=req.notes,
    )
    return {"success": True, "position": position.model_dump()}


@router.get("/positions/{position_id}", tags=["Positions"])
async def get_position(position_id: str):
    """获取单个职位."""
    store = get_position_store()
    position = store.get(position_id)
    if not position:
        raise HTTPException(status_code=404, detail="Position not found")
    return {"success": True, "position": position.model_dump()}


@router.put("/positions/{position_id}", tags=["Positions"])
async def update_position(position_id: str, req: PositionCreateRequest):
    """更新职位."""
    store = get_position_store()
    position = store.get(position_id)
    if not position:
        raise HTTPException(status_code=404, detail="Position not found")
    position.name = req.name or position.name
    position.company_name = req.company_name
    position.company_business_scope = req.company_business_scope
    position.job_title = req.job_title
    position.job_requirements = req.job_requirements
    position.notes = req.notes
    store.save(position)
    return {"success": True, "position": position.model_dump()}


@router.delete("/positions/{position_id}", tags=["Positions"])
async def delete_position(position_id: str):
    """删除职位."""
    store = get_position_store()
    ok = store.delete(position_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Position not found")
    return {"success": True}


# ── 模拟面试 ──

def _serialize_interview_state(iv: MockInterview) -> dict:
    """把 MockInterview 序列化为前端可用的状态."""
    return {
        "interview_id": iv.id,
        "status": iv.status,
        "current_question": iv.current_question.question if iv.current_question else None,
        "current_focus": iv.current_question.focus if iv.current_question else None,
        "current_rationale": iv.current_question.rationale if iv.current_question else None,
        "current_reference_answer": iv.current_question.reference_answer
        if iv.current_question
        else None,
        "turn_index": len(iv.turns),
        "max_turns": iv.max_turns,
        "turns": [t.model_dump() for t in iv.turns],
        "finished": iv.status == "finished",
        "company_name": iv.result.company_name,
        "job_title": iv.result.job_title,
    }


@router.post("/interview/start", tags=["Interview"])
def start_interview(req: InterviewStartRequest):
    """启动一场模拟面试,基于指定 session 的分析结果."""
    try:
        agent = get_agent()
        # 恢复指定 session
        if req.session_id and req.session_id != agent.session.get("id"):
            from hiremind import HireMindAgent, SessionStore, RunStore
            ws = get_workspace()
            agent = HireMindAgent.from_session(
                model_client=agent.model_client,
                workspace=ws,
                session_store=SessionStore(ws.sessions_dir),
                run_store=RunStore(ws.runs_dir),
                session_id=req.session_id,
            )
        result_data = agent.session.get("interview_result")
        if not result_data:
            return {"success": False, "error": "该会话尚未生成分析报告,请先在分析页生成报告"}
        result = InterviewResult.model_validate(result_data)
        iv = new_interview(
            session_id=agent.session["id"],
            result=result,
            resume_text="",
            max_turns=req.max_turns,
            model_client=agent.model_client,
        )
        first_q = iv.start()
        store = get_interview_store()
        store.save(iv)
        state = _serialize_interview_state(iv)
        state["first_question"] = first_q
        return {"success": True, "state": state}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/interview/{interview_id}/answer", tags=["Interview"])
def submit_answer(interview_id: str, req: InterviewAnswerRequest):
    """提交候选人回答,返回即时评价."""
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    try:
        turn = iv.submit_answer(req.answer)
        store.save(iv)
        return {
            "success": True,
            "turn": turn.model_dump(),
            "state": _serialize_interview_state(iv),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/interview/{interview_id}/next", tags=["Interview"])
def next_question(interview_id: str):
    """生成下一道题(或结束面试)."""
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    try:
        result = iv.next_question()
        store.save(iv)
        if result == "__INTERVIEW_FINISHED__":
            report = iv.build_final_report()
            store.save(iv)
            return {
                "success": True,
                "finished": True,
                "report": report.model_dump(),
                "state": _serialize_interview_state(iv),
            }
        return {
            "success": True,
            "finished": False,
            "next_question": result,
            "state": _serialize_interview_state(iv),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/interview/{interview_id}/finish", tags=["Interview"])
def finish_interview(interview_id: str):
    """主动结束面试,生成最终报告."""
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    try:
        report = iv.build_final_report()
        store.save(iv)
        return {
            "success": True,
            "report": report.model_dump(),
            "state": _serialize_interview_state(iv),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/interview/{interview_id}/state", tags=["Interview"])
async def get_interview_state(interview_id: str):
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    return {"success": True, "state": _serialize_interview_state(iv)}


@router.get("/interview", response_model=InterviewListResponse, tags=["Interview"])
async def list_interviews():
    store = get_interview_store()
    items = store.list_all()
    return InterviewListResponse(interviews=items)


@router.delete("/interview/{interview_id}", tags=["Interview"])
async def delete_interview(interview_id: str):
    store = get_interview_store()
    deleted = store.delete(interview_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Interview not found")
    return {"success": True}
