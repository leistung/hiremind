"""API 路由：分析、对话、会话、导出、模型配置、简历、模拟面试."""

import json
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse

from hiremind.models.schemas import (
    InterviewResult,
    InterviewStageType,
    Position,
    ResumeData,
    StageConfig,
)
from hiremind.services import (
    InterviewStore,
    MockInterview,
    PositionStore,
    ResumeStore,
    TEMPLATES,
    DEFAULT_STAGE_CONFIGS,
    export_resume_pdf,
    export_resume_word,
    generate_pdf,
    generate_word,
    new_interview,
    parse_document,
    parse_resume_text_to_structured,
    recommend_stage_configs,
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
    AnalysisSummary,
    AnalysisListResponse,
    AnalysisDetailResponse,
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
    StageRecommendRequest,
    WrittenAnswerRequest,
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
    """启动异步分析任务,立即返回 analysis_id.

    分析在后台线程执行,完成后结果落盘到 analyses/ 目录。
    前端通过 GET /analysis/history/{analysis_id} 轮询结果。
    company_name 与 job_title 可选,留空时使用占位符。
    """
    from hiremind import AnalysisStore, RunStore, HireMindAgent
    from hiremind.analysis_store import new_analysis

    try:
        ws = get_workspace()
        ws.ensure_dirs()
        analysis_store = AnalysisStore(ws.analyses_dir)

        # 创建独立 analysis 记录并立即落盘(status=pending)
        company_name = (req.company_name or "").strip() or "未指定公司"
        job_title = (req.job_title or "").strip() or "未指定岗位"
        # 记录启动时使用的模型,供前端显示(分析启动后改模型不影响本次)
        analysis = new_analysis(
            title=f"{company_name}-{job_title}",
            model=settings.model_name,
        )
        analysis_store.save(analysis)
        analysis_id = analysis["id"]
        analysis_model = analysis["model"]

        # 捕获请求参数,供后台线程使用
        params = {
            "company_name": company_name,
            "company_business_scope": req.company_business_scope or "",
            "job_title": job_title,
            "job_requirements": req.job_requirements,
            "resume": req.resume,
        }

        def _run_in_background():
            """后台线程:创建独立 agent 流式执行分析,每完成一个节点写入 progress."""
            try:
                from hiremind.services.llm_service import get_llm as _get_llm
                from hiremind.tools import run_analysis_with_progress

                llm = _get_llm(
                    model=settings.model_name,
                    api_key=settings.openai_api_key or settings.anthropic_api_key,
                    base_url=settings.openai_base_url,
                )
                agent = HireMindAgent.from_analysis(
                    model_client=llm,
                    workspace=ws,
                    analysis_store=analysis_store,
                    run_store=RunStore(ws.runs_dir),
                    analysis_id=analysis_id,
                )

                # 进度回调:每完成一个节点,把进度写入 analysis 文件供 SSE 读取
                completed_nodes = []

                def _on_progress(node_name: str, label: str):
                    completed_nodes.append({"node": node_name, "label": label})
                    a = analysis_store.load(analysis_id)
                    if a is not None:
                        a["progress"] = {
                            "completed": list(completed_nodes),
                            "current": label if node_name != "done" else None,
                        }
                        analysis_store.save(a)

                run_analysis_with_progress(agent, params, on_progress=_on_progress)
            except Exception as exc:
                # 记录错误到 analysis,供轮询时读取
                a = analysis_store.load(analysis_id)
                if a is not None:
                    a["status"] = "error"
                    a["error"] = str(exc)
                    analysis_store.save(a)

        thread = threading.Thread(target=_run_in_background, daemon=True)
        thread.start()

        return AnalysisResponse(
            success=True,
            result=None,
            analysis_id=analysis_id,
            model=analysis_model,
        )
    except Exception as exc:
        return AnalysisResponse(
            success=False,
            analysis_id="",
            error=str(exc),
        )


# ── 历史记录 ──
# 注:/analysis/history 与 /analysis/history/{id} 已合并到 /analyses 与 /analyses/{id},
# 列表项现在包含 status/company_name/job_title/match_score/rounds_count,
# 详情现在返回 status + result,前端统一用 listAnalyses/getAnalysis。


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


# ── 分析记录管理 ──

@router.get("/analyses", response_model=AnalysisListResponse, tags=["Analysis"])
async def list_analyses():
    """列出所有分析记录摘要(含业务字段与状态)."""
    import json as _json
    from hiremind import AnalysisStore
    ws = get_workspace()
    store = AnalysisStore(ws.analyses_dir)
    analyses: list[AnalysisSummary] = []
    for path in sorted(ws.analyses_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = _json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        result = data.get("interview_result") or {}
        ma = result.get("match_analysis", {}) or {}
        rounds = (result.get("questions", {}) or {}).get("rounds", []) or []
        analyses.append(AnalysisSummary(
            id=data.get("id", path.stem),
            title=data.get("title", "") or "",
            status=data.get("status", "completed"),
            company_name=result.get("company_name", "") or "",
            job_title=result.get("job_title", "") or "",
            match_score=int(ma.get("match_score", 0) or 0),
            rounds_count=len(rounds),
            message_count=len(data.get("history", [])),
            created_at=data.get("created_at", "") or "",
            updated_at=data.get("updated_at", "") or "",
            metadata=data.get("metadata", {}) or {},
        ))
    return AnalysisListResponse(analyses=analyses)


@router.get("/analyses/{analysis_id}", response_model=AnalysisDetailResponse, tags=["Analysis"])
async def get_analysis(analysis_id: str):
    """读取单条分析的状态与完整报告.

    返回 status 字段:pending(进行中) / completed(已完成) / error(失败)。
    status=pending 或 error 时不返回 result。
    """
    from hiremind import AnalysisStore
    ws = get_workspace()
    store = AnalysisStore(ws.analyses_dir)
    analysis = store.load(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    status = analysis.get("status", "completed")
    result = analysis.get("interview_result")
    return AnalysisDetailResponse(
        analysis_id=analysis_id,
        title=analysis.get("title", "") or "",
        status=status,
        created_at=analysis.get("created_at", "") or "",
        updated_at=analysis.get("updated_at", "") or "",
        result=result if status == "completed" and result else None,
        error=analysis.get("error") if status == "error" else None,
        model=analysis.get("model", "") or "",
    )


@router.delete("/analyses/{analysis_id}", tags=["Analysis"])
async def delete_analysis(analysis_id: str):
    """删除指定分析记录."""
    from hiremind import AnalysisStore
    ws = get_workspace()
    store = AnalysisStore(ws.analyses_dir)
    deleted = store.delete(analysis_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return {"success": True}


@router.post("/analyses/{analysis_id}/cancel", tags=["Analysis"])
async def cancel_analysis(analysis_id: str):
    """取消分析任务:把 status 置为 cancelled.

    后台线程仍在执行时无法真正中断 LangGraph,但状态标记为 cancelled 后,
    前端列表会显示"已取消",SSE 也会推送 cancelled 状态并停止。
    """
    from hiremind import AnalysisStore
    ws = get_workspace()
    store = AnalysisStore(ws.analyses_dir)
    analysis = store.load(analysis_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    if analysis.get("status") in ("completed", "error", "cancelled"):
        return {"success": True, "status": analysis.get("status")}
    analysis["status"] = "cancelled"
    analysis["error"] = "用户已取消"
    store.save(analysis)
    return {"success": True, "status": "cancelled"}


@router.get("/analysis/stream/{analysis_id}", tags=["Analysis"])
async def stream_analysis_progress(analysis_id: str):
    """SSE 接口:实时推送分析进度.

    后台线程在执行 LangGraph 节点时会更新 analysis 文件的 progress 字段,
    本接口每秒轮询该字段,变化时推送 SSE 事件。
    当 status 变为 completed / error 时,推送最终事件后关闭流。
    """
    import asyncio
    from hiremind import AnalysisStore

    ws = get_workspace()
    store = AnalysisStore(ws.analyses_dir)

    async def event_generator():
        last_progress = None
        last_status = None
        # 最长保活 10 分钟,防止前端断开后连接悬挂
        max_ticks = 600
        for _ in range(max_ticks):
            analysis = store.load(analysis_id)
            if not analysis:
                yield f"data: {json.dumps({'error': 'Analysis not found'})}\n\n"
                return
            status = analysis.get("status", "pending")
            progress = analysis.get("progress") or {}
            # 终态:completed / error / cancelled
            is_terminal = status in ("completed", "error", "cancelled")
            # 进度变化时推送
            if progress != last_progress:
                payload = {
                    "status": status,
                    "progress": progress,
                }
                # 完成时附带最终结果
                if status == "completed":
                    payload["result"] = analysis.get("interview_result")
                # 出错或取消时附带错误信息
                elif status in ("error", "cancelled"):
                    payload["error"] = analysis.get("error") or ("已取消" if status == "cancelled" else "分析失败")
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                last_progress = progress
                last_status = status
                if is_terminal:
                    return
            # 即使进度没变,状态变化也要推送
            elif status != last_status:
                payload = {"status": status}
                if status == "completed":
                    payload["result"] = analysis.get("interview_result")
                elif status in ("error", "cancelled"):
                    payload["error"] = analysis.get("error") or ("已取消" if status == "cancelled" else "分析失败")
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                last_status = status
                if is_terminal:
                    return
            await asyncio.sleep(1)
        # 超时
        yield f"data: {json.dumps({'error': 'Stream timeout'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # 禁用 nginx 缓冲
            "Connection": "keep-alive",
        },
    )


# ── 报告导出(分析报告)──

@router.post("/export", response_model=ExportResponse, tags=["Export"])
def export_report(req: ExportRequest):
    try:
        agent = get_agent()
        # 优先按 analysis_id 加载历史分析,否则用 agent 当前分析
        if req.analysis_id:
            from hiremind import AnalysisStore
            ws = get_workspace()
            store = AnalysisStore(ws.analyses_dir)
            analysis = store.load(req.analysis_id)
            if not analysis:
                return ExportResponse(success=False, error="分析记录不存在")
            result_data = analysis.get("interview_result")
        else:
            result_data = agent.analysis.get("interview_result")
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
    state = {
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
        # 多阶段字段
        "is_multi_stage": iv.is_multi_stage,
        "current_stage_index": iv.current_stage_index,
        "current_stage_type": (
            iv.stages[iv.current_stage_index].stage_type.value
            if iv.is_multi_stage
            and iv.current_stage_index < len(iv.stages)
            and iv.stages[iv.current_stage_index].status != "completed"
            else None
        ),
        "current_stage_name": (
            iv.stages[iv.current_stage_index].stage_name
            if iv.is_multi_stage
            and iv.current_stage_index < len(iv.stages)
            and iv.stages[iv.current_stage_index].status != "completed"
            else None
        ),
        "stages_progress": [
            {
                "stage_type": s.stage_type.value,
                "stage_name": s.stage_name,
                "status": s.status,
                "stage_score": s.stage_score,
                "turns_count": len(s.turns),
            }
            for s in iv.stages
        ] if iv.is_multi_stage else [],
        # 笔试阶段:题目列表(不含参考答案)
        "written_questions": (
            [
                {
                    "index": i,
                    "title": q.title,
                    "question": q.question,
                    "focus": q.focus,
                    "direction": q.direction,
                }
                for i, q in enumerate(iv.stages[iv.current_stage_index].written_questions)
            ]
            if iv.is_multi_stage
            and iv.current_stage_index < len(iv.stages)
            and iv.stages[iv.current_stage_index].stage_type == InterviewStageType.WRITTEN
            and iv.stages[iv.current_stage_index].status == "in_progress"
            else []
        ),
    }
    return state


@router.post("/interview/stages/recommend", tags=["Interview"])
def recommend_stages(req: StageRecommendRequest):
    """根据分析报告 + 期望轮次,智能规划面试阶段方案.

    LLM 综合判断岗位类别、级别(薪资)、公司类型,输出阶段类型/题数/侧重/理由。
    前端展示后由用户确认,再调用 /interview/start 启动。
    """
    try:
        agent = get_agent()
        if req.analysis_id and req.analysis_id != agent.analysis.get("id"):
            from hiremind import HireMindAgent, AnalysisStore, RunStore
            ws = get_workspace()
            agent = HireMindAgent.from_analysis(
                model_client=agent.model_client,
                workspace=ws,
                analysis_store=AnalysisStore(ws.analyses_dir),
                run_store=RunStore(ws.runs_dir),
                analysis_id=req.analysis_id,
            )
        result_data = agent.analysis.get("interview_result")
        if not result_data:
            return {"success": False, "error": "该分析尚未生成报告,请先在分析页生成报告"}
        result = InterviewResult.model_validate(result_data)
        company_business_scope = agent.analysis.get("company_business_scope", "") or ""
        job_requirements = agent.analysis.get("job_requirements", "") or ""
        configs = recommend_stage_configs(
            result=result,
            expected_rounds=req.expected_rounds,
            company_business_scope=company_business_scope,
            jd_summary=job_requirements,
        )
        return {
            "success": True,
            "stages": [c.model_dump() for c in configs],
            "company_name": result.company_name,
            "job_title": result.job_title,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/interview/start", tags=["Interview"])
def start_interview(req: InterviewStartRequest):
    """启动一场模拟面试,基于指定分析的分析结果.

    支持多阶段:若 req.stages 非空则用多阶段模式,否则用旧版单场模式。
    """
    try:
        agent = get_agent()
        # 恢复指定分析
        if req.analysis_id and req.analysis_id != agent.analysis.get("id"):
            from hiremind import HireMindAgent, AnalysisStore, RunStore
            ws = get_workspace()
            agent = HireMindAgent.from_analysis(
                model_client=agent.model_client,
                workspace=ws,
                analysis_store=AnalysisStore(ws.analyses_dir),
                run_store=RunStore(ws.runs_dir),
                analysis_id=req.analysis_id,
            )
        result_data = agent.analysis.get("interview_result")
        if not result_data:
            return {"success": False, "error": "该分析尚未生成报告,请先在分析页生成报告"}
        result = InterviewResult.model_validate(result_data)

        # 解析阶段配置:空则用默认4阶段
        stage_configs: List[StageConfig] = []
        if req.stages:
            for s in req.stages:
                if not s.get("enabled", True):
                    continue
                stage_configs.append(StageConfig.model_validate(s))
        if not stage_configs and req.stages is not None and len(req.stages) > 0:
            # 全部被禁用,回退到默认
            stage_configs = list(DEFAULT_STAGE_CONFIGS)

        iv = new_interview(
            analysis_id=agent.analysis["id"],
            result=result,
            resume_text="",
            max_turns=req.max_turns,
            model_client=agent.model_client,
            stage_configs=stage_configs or None,
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
    """生成下一道题(或结束面试/阶段完成)."""
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
        if result == "__STAGE_COMPLETED__":
            # 当前阶段已完成,等待前端调用 /advance 进入下一阶段
            stage = iv.current_stage
            return {
                "success": True,
                "finished": False,
                "stage_completed": True,
                "stage_summary": {
                    "stage_type": stage.stage_type.value if stage else None,
                    "stage_name": stage.stage_name if stage else "",
                    "stage_score": stage.stage_score if stage else 0,
                    "stage_summary": stage.stage_summary if stage else "",
                    "promotion_hint": stage.promotion_hint if stage else "",
                } if stage else None,
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


@router.post("/interview/{interview_id}/written/submit", tags=["Interview"])
def submit_written_answers(interview_id: str, req: WrittenAnswerRequest):
    """笔试批量提交答案,返回逐题评价 + 阶段总结."""
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    try:
        # answers 键是字符串序号,转成 int
        answers = {int(k): v for k, v in req.answers.items()}
        result = iv.submit_written_answers(answers)
        store.save(iv)
        return {
            "success": True,
            "turns": result["turns"],
            "stage_score": result["stage_score"],
            "stage_summary": result["stage_summary"],
            "promotion_hint": result["promotion_hint"],
            "state": _serialize_interview_state(iv),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/interview/{interview_id}/advance", tags=["Interview"])
def advance_stage(interview_id: str):
    """进入下一个面试阶段(多阶段模式)."""
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    if not iv.is_multi_stage:
        return {"success": False, "error": "当前面试不是多阶段模式"}
    try:
        result = iv.advance_to_next_stage()
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
        if result == "__WRITTEN_READY__":
            return {
                "success": True,
                "finished": False,
                "written_ready": True,
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


@router.post("/interview/{interview_id}/abandon", tags=["Interview"])
def abandon_interview(interview_id: str):
    """放弃面试:把 status 置为 abandoned,不生成报告.

    与 finish 的区别:finish 会调用 LLM 生成最终报告(耗时),
    abandon 直接标记状态并保存,适合用户中途退出不想要报告的场景。
    已 finished/abandoned 的面试不可重复放弃。
    """
    store = get_interview_store()
    agent = get_agent()
    iv = store.load(interview_id, model_client=agent.model_client)
    if not iv:
        raise HTTPException(status_code=404, detail="Interview not found")
    if iv.status in ("finished", "abandoned"):
        return {"success": True, "status": iv.status}
    iv.status = "abandoned"
    store.save(iv)
    return {"success": True, "status": "abandoned"}


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
