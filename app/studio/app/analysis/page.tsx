"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { downloadReport, relativeTime, scoreColor } from "@/lib/utils";
import FullscreenPreview, { FullscreenButton } from "@/components/FullscreenPreview";
import ModelBadge from "@/components/ModelBadge";
import type {
  AnalysisDetail,
  AnalysisResponse,
  InterviewResult,
  InterviewRound,
  PositionListItem,
  Question,
  ResumeData,
  ResumeListItem,
  AnalysisSummary,
  StreamAnalysisProgress,
} from "@/lib/types";

type ResumeSource =
  | { kind: "none" }
  | { kind: "selected"; id: string; name: string; text: string; data: ResumeData | null }
  | { kind: "uploaded"; name: string; text: string; data: ResumeData | null };

// 持久化 key:用于跨页面切换/刷新恢复分析状态
const STATE_KEY = "hiremind:analysis-state-v1";

interface PersistedState {
  analysisId: string;
  running: boolean;
  // 分析开始的时间戳:用于恢复时在历史记录中找到本次分析对应的记录
  analysisStartedAt: number;
  // 表单快照(返回时恢复输入,但不强制覆盖用户重新输入)
  form: {
    companyName: string;
    businessScope: string;
    jobTitle: string;
    jobRequirements: string;
    selectedPositionId: string;
  };
  // 简历来源快照(简化版,返回时恢复种类与名称,数据可重新加载)
  resume: {
    kind: "none" | "selected" | "uploaded";
    id?: string;
    name: string;
    text: string;
  };
  // 已有结果(若分析已完成,直接恢复,避免再请求)
  result?: InterviewResult | null;
  savedAt: number;
}

export default function AnalysisPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-stone-400">加载中…</div>}>
      <AnalysisPageInner />
    </Suspense>
  );
}

function AnalysisPageInner() {
  // 表单
  const [companyName, setCompanyName] = useState("");
  const [businessScope, setBusinessScope] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobRequirements, setJobRequirements] = useState("");
  const [resumes, setResumes] = useState<ResumeListItem[]>([]);
  const [positions, setPositions] = useState<PositionListItem[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [resumeSource, setResumeSource] = useState<ResumeSource>({ kind: "none" });
  const [loadingResumeText, setLoadingResumeText] = useState(false);
  const [parsingResume, setParsingResume] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchParams = useSearchParams();

  // 结果
  const [result, setResult] = useState<InterviewResult | null>(null);
  const [analysisId, setAnalysisId] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  // 流式进度:已完成节点 + 当前节点
  const [progress, setProgress] = useState<StreamAnalysisProgress | null>(null);
  // 本次分析启动时使用的模型(从后端 response/detail 读取,运行中不随全局配置变化)
  const [analysisModel, setAnalysisModel] = useState("");

  // 恢复标记:仅初始化时读取一次 sessionStorage
  const [restored, setRestored] = useState(false);
  // SSE abort 函数:组件卸载或新一轮分析时调用,断开旧连接
  const streamAbortRef = useRef<(() => void) | null>(null);

  // 分析记录管理
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [loadingAnalyses, setLoadingAnalyses] = useState(false);
  const [deletingAnalysisId, setDeletingAnalysisId] = useState("");

  // 初始化:读取 sessionStorage 恢复上次未完成的分析
  useEffect(() => {
    if (restored) return;
    setRestored(true);
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return;
      const ps: PersistedState = JSON.parse(raw);
      // 只恢复 30 分钟内的状态,过期视为失效
      if (Date.now() - ps.savedAt > 30 * 60 * 1000) {
        sessionStorage.removeItem(STATE_KEY);
        return;
      }
      // 恢复表单
      setCompanyName(ps.form.companyName || "");
      setBusinessScope(ps.form.businessScope || "");
      setJobTitle(ps.form.jobTitle || "");
      setJobRequirements(ps.form.jobRequirements || "");
      setSelectedPositionId(ps.form.selectedPositionId || "");
      // 恢复简历来源
      if (ps.resume.kind === "selected" && ps.resume.id) {
        // 重新拉取完整数据(含 data)
        api.getResume(ps.resume.id).then((r) => {
          const text =
            r.resume.raw_text ||
            buildResumeText(r.resume.data, r.resume.name);
          setResumeSource({
            kind: "selected",
            id: ps.resume.id!,
            name: ps.resume.name,
            text,
            data: r.resume.data,
          });
        }).catch(() => {
          // 拉取失败则用快照中的 text
          setResumeSource({
            kind: "selected",
            id: ps.resume.id!,
            name: ps.resume.name,
            text: ps.resume.text,
            data: null,
          });
        });
      } else if (ps.resume.kind === "uploaded") {
        setResumeSource({
          kind: "uploaded",
          name: ps.resume.name,
          text: ps.resume.text,
          data: null,
        });
      }
      // 恢复 analysis 状态
      setAnalysisId(ps.analysisId || "");
      if (ps.running && ps.analysisStartedAt) {
        // 分析进行中:用 SSE 续接进度(若有 analysisId)
        setResult(null);
        setRunning(true);
        if (ps.analysisId) {
          // 先拉一次详情获取启动时模型,再开 SSE
          api.getAnalysis(ps.analysisId).then((d) => {
            if (d.model) setAnalysisModel(d.model);
          }).catch(() => {});
          streamAnalysisResult(ps.analysisId);
        } else {
          setRunning(false);
          setError("分析状态已失效,请重新开始分析。");
        }
      } else if (ps.result) {
        // 已有结果:直接恢复(模型从详情拉取)
        setResult(ps.result);
        if (ps.analysisId) {
          api.getAnalysis(ps.analysisId).then((d) => {
            if (d.model) setAnalysisModel(d.model);
          }).catch(() => {});
        }
      }
    } catch {
      // JSON 解析失败,忽略
    }
  }, [restored]);

  // 进入空状态(无结果且未运行)时自动加载分析列表
  useEffect(() => {
    if (!result && !running && analyses.length === 0 && !loadingAnalyses) {
      loadAnalyses();
    }
  }, [result, running]);

  // 持久化:running / result / analysisId / 表单 任一变化时同步到 sessionStorage
  // 用 ref 保存 analysisStartedAt,避免它变化触发持久化 effect(它只在 runAnalysis 时设置)
  const analysisStartedAtRef = useRef<number>(0);
  useEffect(() => {
    if (!restored) return;
    // 从 sessionStorage 读取已保存的 analysisStartedAt(恢复时用)
    if (analysisStartedAtRef.current === 0) {
      try {
        const raw = sessionStorage.getItem(STATE_KEY);
        if (raw) {
          const ps = JSON.parse(raw) as PersistedState;
          analysisStartedAtRef.current = ps.analysisStartedAt || 0;
        }
      } catch {}
    }
    const ps: PersistedState = {
      analysisId,
      running,
      analysisStartedAt: analysisStartedAtRef.current,
      form: {
        companyName,
        businessScope,
        jobTitle,
        jobRequirements,
        selectedPositionId,
      },
      resume:
        resumeSource.kind === "none"
          ? { kind: "none", name: "", text: "" }
          : resumeSource.kind === "selected"
            ? { kind: "selected", id: resumeSource.id, name: resumeSource.name, text: resumeSource.text }
            : { kind: "uploaded", name: resumeSource.name, text: resumeSource.text },
      result: running ? null : result,
      savedAt: Date.now(),
    };
    try {
      if (analysisId || result || running || resumeSource.kind !== "none") {
        sessionStorage.setItem(STATE_KEY, JSON.stringify(ps));
      } else {
        // 状态空了,清掉避免下次恢复空白
        sessionStorage.removeItem(STATE_KEY);
        analysisStartedAtRef.current = 0;
      }
    } catch {}
  }, [restored, analysisId, running, result, companyName, businessScope, jobTitle, jobRequirements, selectedPositionId, resumeSource]);

  // 流式接收分析进度:SSE 推送节点完成事件,实时更新 progress state
  // knownAid:已知的 analysisId
  function streamAnalysisResult(knownAid: string) {
    // 断开旧连接
    if (streamAbortRef.current) {
      streamAbortRef.current();
      streamAbortRef.current = null;
    }
    setProgress({ completed: [], current: null });
    const abort = api.streamAnalysis(knownAid, (payload) => {
      if (payload.progress) {
        setProgress(payload.progress);
      }
      if (payload.status === "completed" && payload.result) {
        setResult(payload.result);
        setAnalysisId(knownAid);
        setRunning(false);
        setError("");
        setProgress(null);
        streamAbortRef.current = null;
      } else if (payload.status === "error") {
        setRunning(false);
        setError(payload.error || "分析失败");
        setProgress(null);
        streamAbortRef.current = null;
      } else if (payload.status === "cancelled") {
        setRunning(false);
        setError(payload.error || "已取消");
        setProgress(null);
        streamAbortRef.current = null;
      } else if (payload.error) {
        // 连接级错误(非业务错误)
        setRunning(false);
        setError(payload.error);
        setProgress(null);
        streamAbortRef.current = null;
      }
    });
    streamAbortRef.current = abort;
  }

  // 组件卸载时断开 SSE 连接
  useEffect(() => {
    return () => {
      if (streamAbortRef.current) {
        streamAbortRef.current();
        streamAbortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    api.listResumes().then((r) => setResumes(r.resumes || [])).catch(() => {});
    api.listPositions().then((r) => setPositions(r.positions || [])).catch(() => {});
  }, []);

  // 从 URL 参数预选职位 (?position=id)
  const pid = searchParams.get("position");
  useEffect(() => {
    if (pid && positions.length > 0 && !selectedPositionId) {
      selectPosition(pid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, positions]);

  async function selectResume(id: string) {
    invalidateResult();
    if (!id) {
      setResumeSource({ kind: "none" });
      return;
    }
    const item = resumes.find((r) => r.id === id);
    if (!item) return;
    setLoadingResumeText(true);
    try {
      const r = await api.getResume(id);
      const text =
        r.resume.raw_text ||
        buildResumeText(r.resume.data, r.resume.name);
      setResumeSource({
        kind: "selected",
        id,
        name: item.basics_name || item.name,
        text,
        data: r.resume.data,
      });
    } catch {
      setError("加载简历失败");
    } finally {
      setLoadingResumeText(false);
    }
  }

  async function selectPosition(id: string) {
    invalidateResult();
    if (!id) {
      setSelectedPositionId("");
      return;
    }
    try {
      const r = await api.getPosition(id);
      const p = r.position;
      setSelectedPositionId(p.id);
      // 自动填充表单(不覆盖已填的非空字段,避免丢失手动输入)
      setCompanyName(p.company_name || companyName);
      setBusinessScope(p.company_business_scope || businessScope);
      setJobTitle(p.job_title || jobTitle);
      if (p.job_requirements) setJobRequirements(p.job_requirements);
      setError("");
    } catch {
      setError("加载职位详情失败");
    }
  }

  async function handleUpload(file: File) {
    setError("");
    setParsingResume(true);
    try {
      const r = await api.uploadParseResume(file);
      if (!r.success || !r.text) {
        setError(r.error || "解析失败");
        return;
      }
      invalidateResult();
      setResumeSource({
        kind: "uploaded",
        name: file.name,
        text: r.text,
        data: r.data || null,
      });
    } catch (e) {
      // 区分超时(5 分钟 abort)和其他错误
      const msg = e instanceof Error && e.name === "AbortError"
        ? "解析超时(超过 5 分钟)。LLM 结构化较慢,建议先在「简历库」新建简历并粘贴文本,再回到此页面选择该简历。"
        : "上传失败,可能是后端服务未响应或解析超时。可尝试先保存到简历库再选择。";
      setError(msg);
    } finally {
      setParsingResume(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function runAnalysis() {
    setError("");
    if (!jobRequirements.trim()) return setError("请填写岗位要求 / JD 正文");
    if (resumeSource.kind === "none") return setError("请选择或上传简历");

    // 断开旧的 SSE 连接(如果有)
    if (streamAbortRef.current) {
      streamAbortRef.current();
      streamAbortRef.current = null;
    }
    const startedAt = Date.now();
    analysisStartedAtRef.current = startedAt;
    setRunning(true);
    setResult(null);
    setAnalysisId("");
    setProgress({ completed: [], current: null });
    // 立即持久化 running=true + 开始时间,确保切换页面后能恢复
    try {
      const ps: PersistedState = {
        analysisId: "",
        running: true,
        analysisStartedAt: startedAt,
        form: { companyName, businessScope, jobTitle, jobRequirements, selectedPositionId },
        resume:
          resumeSource.kind === "selected"
            ? { kind: "selected" as const, id: resumeSource.id, name: resumeSource.name, text: resumeSource.text }
            : { kind: "uploaded" as const, name: resumeSource.name, text: resumeSource.text },
        result: null,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(STATE_KEY, JSON.stringify(ps));
    } catch {}

    try {
      const selectedPos = positions.find((p) => p.id === selectedPositionId);
      const r: AnalysisResponse = await api.runAnalysis({
        company_name: companyName,
        company_business_scope: businessScope,
        job_title: jobTitle,
        job_requirements: jobRequirements,
        resume: resumeSource.text,
        resume_id: resumeSource.kind === "selected" ? resumeSource.id : undefined,
        resume_name: resumeSource.name,
        position_id: selectedPositionId || undefined,
        position_name: selectedPos ? selectedPos.name : undefined,
      });
      if (!r.success || !r.analysis_id) {
        setError(r.error || "分析启动失败");
        setRunning(false);
        return;
      }
      // 后端异步执行:立即拿到 analysis_id 与启动时模型,用 SSE 接收进度
      setAnalysisId(r.analysis_id);
      if (r.model) setAnalysisModel(r.model);
      streamAnalysisResult(r.analysis_id);
    } catch (e) {
      setError("请求失败,请检查后端服务是否正常运行。");
      setRunning(false);
    }
  }

  async function handleExport(format: "word" | "pdf") {
    if (!analysisId) return;
    setExporting(format);
    try {
      const r = await api.exportAnalysisReport(format, analysisId);
      if (!r.success || !r.filename) {
        setError(r.error || "导出失败");
        return;
      }
      await downloadReport(r.filename, api.downloadUrl(r.filename));
    } catch {
      setError("导出失败");
    } finally {
      setExporting("");
    }
  }

  const canRun =
    jobRequirements.trim() && resumeSource.kind !== "none" && !running;

  // 停止分析确认弹窗:点击「停止分析」只显示弹窗,不修改任何状态
  // 只有用户点击「确认停止」后才真正执行停止逻辑
  const [showStopConfirm, setShowStopConfirm] = useState(false);

  // 作废已有结果:当用户修改了任何输入(简历/JD/职位/公司等)时调用
  // 清掉 result 和 analysisId,让按钮回到「开始分析」状态,右侧回到空白
  // 但不清理表单输入本身——用户正在编辑,清表单会很反直觉
  function invalidateResult() {
    if (result === null && analysisId === "" && progress === null) return;
    setResult(null);
    setAnalysisId("");
    setError("");
    setProgress(null);
    setAnalysisModel("");
    analysisStartedAtRef.current = 0;
    try {
      // 只清掉 result 部分,保留表单的持久化(由后续持久化 effect 自动同步)
      const raw = sessionStorage.getItem(STATE_KEY);
      if (raw) {
        const ps = JSON.parse(raw) as PersistedState;
        ps.result = null;
        ps.analysisId = "";
        ps.running = false;
        ps.analysisStartedAt = 0;
        ps.savedAt = Date.now();
        sessionStorage.setItem(STATE_KEY, JSON.stringify(ps));
      }
    } catch {}
  }

  // 请求停止:只弹窗,不动状态
  function requestStop() {
    setShowStopConfirm(true);
  }

  // 确认停止:真正执行停止逻辑
  async function confirmStop() {
    setShowStopConfirm(false);
    // 如果在弹窗期间分析已自然完成(running 已变 false),无需再停止
    if (!running) return;
    const aidToCancel = analysisId;
    if (streamAbortRef.current) {
      streamAbortRef.current();
      streamAbortRef.current = null;
    }
    setRunning(false);
    setResult(null);
    setAnalysisId("");
    setError("");
    setProgress(null);
    setAnalysisModel("");
    analysisStartedAtRef.current = 0;
    try {
      sessionStorage.removeItem(STATE_KEY);
    } catch {}
    // 通知后端把记录状态改为 cancelled(失败不阻塞,记录仍会在后台线程结束后变为 completed)
    if (aidToCancel) {
      try {
        await api.cancelAnalysis(aidToCancel);
        // 刷新列表,让"分析中"立即变为"已取消"
        loadAnalyses();
      } catch {}
    }
  }

  // 取消停止:只关弹窗,状态完全不变
  function cancelStop() {
    setShowStopConfirm(false);
  }

  // 分析记录管理:加载分析列表
  async function loadAnalyses() {
    setLoadingAnalyses(true);
    try {
      const r = await api.listAnalyses();
      setAnalyses(r.analyses || []);
    } catch {
      setAnalyses([]);
    } finally {
      setLoadingAnalyses(false);
    }
  }

  // 分析记录管理:加载某条分析的结果
  async function loadAnalysisResult(aid: string) {
    try {
      const r = await api.getAnalysis(aid);
      if (r.status === "completed" && r.result) {
        setResult(r.result);
        setAnalysisId(aid);
        setAnalysisModel(r.model || "");
        setError("");
      } else if (r.status === "error") {
        setError(r.error || "该分析失败");
      } else if (r.status === "cancelled") {
        setError(r.error || "该分析已被取消");
      } else {
        setError("该分析尚未完成");
      }
    } catch {
      setError("加载分析失败");
    }
  }

  // 分析记录管理:删除分析
  async function deleteAnalysis(aid: string) {
    if (!confirm("确定删除该分析?删除后不可恢复。")) return;
    setDeletingAnalysisId(aid);
    try {
      await api.deleteAnalysis(aid);
      setAnalyses((prev) => prev.filter((a) => a.id !== aid));
    } catch {
      setError("删除分析失败");
    } finally {
      setDeletingAnalysisId("");
    }
  }

  return (
    <div className="flex h-screen">
      {/* 左侧:表单 */}
      <div
        className="w-[440px] shrink-0 flex flex-col border-r overflow-y-auto"
        style={{ background: "var(--bg-sidebar)", borderColor: "var(--border)" }}
      >
        <div className="p-5">
          <div className="badge badge-accent mb-2">面试分析</div>
          <h1 className="text-[20px] font-semibold text-stone-800 mb-1">
            JD × 简历深度分析
          </h1>
          <p className="text-[12px] text-stone-500 leading-relaxed">
            输入岗位信息与简历,生成匹配度、改进点、3-5 轮面试题与参考答案
          </p>
        </div>

        <div className="px-5 pb-5 space-y-4">
          {/* JD 部分 */}
          <div className="card p-4">
            <div className="section-title">岗位信息</div>

            {/* 从职位库快速选择 */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <label className="label mb-0">从职位库选择(自动填充)</label>
                {positions.length > 0 && (
                  <Link href="/positions" className="text-[11px] text-orange-700 hover:underline">
                    管理职位库 →
                  </Link>
                )}
              </div>
              {positions.length === 0 ? (
                <div className="text-[12px] text-stone-400 py-1">
                  职位库为空,
                  <Link href="/positions" className="text-orange-700 hover:underline">
                    去添加职位 →
                  </Link>
                </div>
              ) : (
                <select
                  className="input"
                  value={selectedPositionId}
                  onChange={(e) => selectPosition(e.target.value)}
                >
                  <option value="">— 手动输入或选择已保存职位 —</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.company_name ? ` · ${p.company_name}` : ""}
                      {p.job_title ? ` · ${p.job_title}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <label className="label">公司名称(可选)</label>
                <input
                  className="input"
                  value={companyName}
                  onChange={(e) => {
                    setCompanyName(e.target.value);
                    invalidateResult();
                  }}
                  placeholder="如:字节跳动(留空可仅按 JD 分析)"
                />
              </div>
              <div>
                <label className="label">业务范围(可选)</label>
                <input
                  className="input"
                  value={businessScope}
                  onChange={(e) => {
                    setBusinessScope(e.target.value);
                    invalidateResult();
                  }}
                  placeholder="如:短视频、电商、教育"
                />
              </div>
              <div>
                <label className="label">职位名称(可选)</label>
                <input
                  className="input"
                  value={jobTitle}
                  onChange={(e) => {
                    setJobTitle(e.target.value);
                    invalidateResult();
                  }}
                  placeholder="如:高级产品经理"
                />
              </div>
              <div>
                <label className="label">岗位要求 / JD 正文 *</label>
                <textarea
                  className="input"
                  rows={8}
                  value={jobRequirements}
                  onChange={(e) => {
                    setJobRequirements(e.target.value);
                    invalidateResult();
                  }}
                  placeholder="把 JD 中的岗位职责与任职要求贴在这里…"
                />
              </div>
            </div>
          </div>

          {/* 简历来源 */}
          <div className="card p-4">
            <div className="section-title">简历来源</div>
            <div className="space-y-3">
              <div>
                <label className="label">从已保存的简历中选择</label>
                {resumes.length === 0 ? (
                  <div className="text-[12px] text-stone-400 py-2">
                    暂无简历,
                    <Link href="/resumes" className="text-orange-700">
                      去创建 →
                    </Link>
                  </div>
                ) : (
                  <select
                    className="input"
                    value={resumeSource.kind === "selected" ? resumeSource.id : ""}
                    onChange={(e) => selectResume(e.target.value)}
                  >
                    <option value="">— 请选择 —</option>
                    {resumes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.basics_name || r.name} · {relativeTime(r.updated_at)}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
                <span className="text-[11px] text-stone-400">或</span>
                <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
              </div>

              <button
                onClick={() => fileRef.current?.click()}
                className="btn btn-secondary w-full"
                disabled={loadingResumeText || parsingResume}
              >
                {parsingResume
                  ? "解析中(预计 1-5 分钟)…"
                  : loadingResumeText
                    ? "加载中…"
                    : "上传 Word / PDF 简历"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt,.md"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                }}
              />
            </div>

            {/* 解析耗时说明 */}
            {!parsingResume && (
              <div className="text-[11px] text-stone-400 leading-relaxed -mt-1">
                上传后会调用 LLM 提取结构化信息,可能需要 1-5 分钟。如急需使用,可先在「简历库」手动创建。
              </div>
            )}

            {/* 当前选中状态 */}
            {resumeSource.kind !== "none" && (
              <div
                className="mt-3 px-3 py-2 rounded-lg text-[12px] flex items-center gap-2"
                style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="flex-1 truncate">
                  {resumeSource.kind === "selected" ? "已选简历:" : "已上传:"} {resumeSource.name}
                </span>
                <button
                  className="opacity-60 hover:opacity-100"
                  onClick={() => {
                    invalidateResult();
                    setResumeSource({ kind: "none" });
                  }}
                >
                  ×
                </button>
              </div>
            )}

            {/* 解析预览(上传后或选中后展示) */}
            {parsingResume && (
              <div className="mt-3 p-3 rounded-lg text-[12px] text-stone-500 flex items-center gap-2" style={{ background: "var(--bg-muted)" }}>
                <div className="w-3.5 h-3.5 rounded-full border-2 border-orange-200 border-t-orange-600 animate-spin" />
                正在解析简历,提取结构化信息…
              </div>
            )}
            {!parsingResume && resumeSource.kind !== "none" && (
              <ResumeParsePreview data={resumeSource.data} text={resumeSource.text} />
            )}
          </div>

          {/* 运行按钮 */}
          {running ? (
            <div className="flex gap-2">
              <button
                disabled
                className="btn btn-primary flex-1 cursor-not-allowed"
                style={{ padding: "10px 16px", fontSize: 14 }}
              >
                <span className="pulse-soft">●</span>
                正在分析(预计 2-5 分钟)…
              </button>
              <button
                onClick={requestStop}
                className="btn btn-danger"
                style={{ padding: "10px 16px", fontSize: 14 }}
                title="停止当前分析,保留表单内容可重新开始"
              >
                停止分析
              </button>
            </div>
          ) : (
            <button
              onClick={runAnalysis}
              disabled={!canRun}
              className="btn btn-primary w-full"
              style={{ padding: "10px 16px", fontSize: 14 }}
            >
              {result ? "重新分析" : "开始分析"}
            </button>
          )}

          {running && (
            <div className="text-[11px] text-stone-400 leading-relaxed -mt-2">
              LLM 正在生成匹配度、改进点、面试题与参考答案。可切换到其他页面查看资料,返回时会自动恢复进度。如需立即重新分析,点击「停止分析」。
            </div>
          )}

          {error && (
            <div
              className="px-3 py-2 rounded-lg text-[12px]"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}
        </div>
      </div>

      {/* 右侧:报告 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {!result && !running && (
          <div className="h-full flex flex-col">
            {/* 顶部提示 */}
            <div className="flex flex-col items-center justify-center py-10 text-stone-400">
              <svg className="w-12 h-12 mb-3 opacity-40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div className="text-[14px]">完成左侧表单后,这里会显示分析报告</div>
              <div className="text-[12px] mt-1">或从下方分析记录中加载历史分析</div>
            </div>

            {/* 分析记录管理 */}
            <div className="flex-1 px-8 pb-8 overflow-y-auto">
              <div className="max-w-[720px] mx-auto">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-[15px] font-semibold text-stone-700">分析记录</h2>
                  <button
                    onClick={loadAnalyses}
                    disabled={loadingAnalyses}
                    className="btn btn-secondary text-[12px]"
                    style={{ padding: "5px 12px" }}
                  >
                    {loadingAnalyses ? "刷新中…" : "刷新"}
                  </button>
                </div>

                {loadingAnalyses && analyses.length === 0 ? (
                  <div className="text-[13px] text-stone-400 py-8 text-center">加载中…</div>
                ) : analyses.length === 0 ? (
                  <div className="text-[13px] text-stone-400 py-8 text-center">
                    暂无分析记录,完成左侧表单后点击「开始分析」即可创建
                  </div>
                ) : (
                  <div className="space-y-2">
                    {analyses.map((a) => (
                      <div
                        key={a.id}
                        className="card p-3 flex items-center gap-3 hover:shadow-sm transition-shadow"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-stone-700 truncate">
                            {a.company_name || a.title || "未命名分析"}
                            {a.job_title ? ` · ${a.job_title}` : ""}
                          </div>
                          <div className="text-[11px] text-stone-400 mt-0.5 flex items-center gap-3">
                            <span>{relativeTime(a.updated_at || a.created_at)}</span>
                            {a.status === "pending" && (
                              <span style={{ color: "var(--accent)" }}>分析中…</span>
                            )}
                            {a.status === "error" && (
                              <span style={{ color: "var(--danger)" }}>失败</span>
                            )}
                            {a.status === "cancelled" && (
                              <span style={{ color: "var(--fg-muted)" }}>已取消</span>
                            )}
                            {a.status === "completed" && a.match_score > 0 && (
                              <span>{a.match_score} 分</span>
                            )}
                            {a.message_count > 0 && (
                              <span>{a.message_count} 条消息</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => loadAnalysisResult(a.id)}
                          className="btn btn-secondary text-[12px]"
                          style={{ padding: "4px 12px" }}
                          title="加载该分析的报告"
                        >
                          加载
                        </button>
                        <button
                          onClick={() => deleteAnalysis(a.id)}
                          disabled={deletingAnalysisId === a.id}
                          className="btn btn-danger text-[12px]"
                          style={{ padding: "4px 12px" }}
                          title="删除该分析"
                        >
                          {deletingAnalysisId === a.id ? "…" : "删除"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {running && (
          <div className="h-full overflow-y-auto">
            <div className="max-w-[720px] mx-auto px-8 py-10">
              {/* 顶部标题 */}
              <div className="flex items-center gap-3 mb-6">
                <div className="w-9 h-9 rounded-full border-2 border-orange-200 border-t-orange-600 animate-spin shrink-0" />
                <div className="flex-1">
                  <div className="text-[16px] font-semibold text-stone-800">
                    AI 正在深度分析…
                  </div>
                  <div className="text-[12px] text-stone-500 mt-0.5">
                    预计 2-5 分钟,可切换页面查看资料,返回时自动恢复进度
                  </div>
                </div>
                {analysisModel && <ModelBadge variant="inline" model={analysisModel} />}
              </div>

              {/* 节点进度列表 */}
              <AnalysisProgress progress={progress} />

              {/* 当前节点提示 */}
              {progress?.current && (
                <div
                  className="mt-4 px-4 py-3 rounded-lg text-[13px] flex items-center gap-2"
                  style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
                >
                  <div className="w-3 h-3 rounded-full border-2 border-orange-300 border-t-orange-600 animate-spin shrink-0" />
                  <span className="flex-1">正在执行:<span className="font-semibold">{progress.current}</span></span>
                </div>
              )}
            </div>
          </div>
        )}

        {result && !running && (
          <div className="max-w-[960px] mx-auto p-8 fade-in">
            {/* 报告头 */}
            <div className="flex items-start justify-between mb-6">
              <div>
                <h1 className="text-[22px] font-semibold text-stone-800 mb-1">
                  {result.company_name || "未指定公司"} · {result.job_title || "未指定岗位"}
                </h1>
                <div className="text-[12px] text-stone-400">面试分析报告</div>
              </div>
              <div className="flex items-center gap-2">
                <FullscreenButton onClick={() => setFullscreen(true)} />
                <button
                  onClick={() => handleExport("word")}
                  disabled={!!exporting}
                  className="btn btn-secondary"
                >
                  {exporting === "word" ? "…" : "导出 Word"}
                </button>
                <button
                  onClick={() => handleExport("pdf")}
                  disabled={!!exporting}
                  className="btn btn-secondary"
                >
                  {exporting === "pdf" ? "…" : "导出 PDF"}
                </button>
                <Link
                  href={`/interview?analysis=${analysisId}`}
                  className="btn btn-primary"
                >
                  去模拟面试 →
                </Link>
              </div>
            </div>

            {/* analysis_id 显示条:供用户复制粘贴到模拟面试页 */}
            {analysisId && (
              <div className="mb-6 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <AnalysisIdBar id={analysisId} />
                </div>
                {analysisModel && <ModelBadge model={analysisModel} />}
              </div>
            )}

            {/* 报告主体(可复用) */}
            <ReportBody result={result} />
          </div>
        )}
      </div>

      {/* 全屏预览 */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={result ? `${result.company_name || "未指定公司"} · ${result.job_title || "未指定岗位"}` : "面试分析报告"}
        subtitle="面试分析报告 · 按 Esc 退出"
        maxWidth={960}
      >
        {result && <ReportBody result={result} />}
      </FullscreenPreview>

      {/* 停止分析确认弹窗 */}
      {showStopConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(28, 25, 23, 0.4)" }}
          onClick={cancelStop}
        >
          <div
            className="rounded-2xl shadow-xl max-w-[400px] w-[90%] fade-in"
            style={{ background: "var(--bg-elevated)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: "var(--danger-soft)" }}
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="text-[15px] font-semibold text-stone-800">
                    停止当前分析?
                  </div>
                </div>
              </div>
              <div className="text-[13px] text-stone-600 leading-relaxed mb-5">
                停止后,正在进行的分析将被中断。已填写的岗位信息与简历选择会保留,你可以修改后重新开始分析。
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={cancelStop} className="btn btn-ghost">
                  取消
                </button>
                <button
                  onClick={confirmStop}
                  className="btn btn-danger"
                  style={{ padding: "8px 16px", fontSize: 13 }}
                >
                  确认停止
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── analysis_id 显示条:点击复制,供用户粘贴到模拟面试页 ──
function AnalysisIdBar({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 降级:选中文字
      const range = document.createRange();
      const sel = window.getSelection();
      const el = document.getElementById(`aid-${id}`);
      if (el && sel) {
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  return (
    <div
      className="px-4 py-3 rounded-lg flex items-center gap-3"
      style={{ background: "var(--bg-muted)", border: "1px solid var(--border)" }}
    >
      <svg
        className="w-4 h-4 text-stone-400 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-12 12a2 2 0 01-2.828 0l-7-7A2 2 0 013 13V8a5 5 0 015-5z"
        />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-stone-500 mb-0.5">分析记录 ID(可用于模拟面试)</div>
        <div
          id={`aid-${id}`}
          className="text-[12px] font-mono text-stone-700 truncate"
          title={id}
        >
          {id}
        </div>
      </div>
      <button
        onClick={handleCopy}
        className="btn btn-secondary text-[12px] shrink-0"
        style={{ padding: "5px 12px" }}
        title="复制 ID"
      >
        {copied ? (
          <span className="flex items-center gap-1" style={{ color: "var(--success)" }}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            已复制
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            复制
          </span>
        )}
      </button>
    </div>
  );
}

// ── 分析进度展示:SSE 推送的已完成节点列表 ──
const TOTAL_NODES = [
  { node: "parse_jd", label: "解析岗位要求" },
  { node: "parse_resume", label: "解析简历" },
  { node: "analyze_match", label: "匹配度分析" },
  { node: "infer_scenarios", label: "推断业务场景" },
  { node: "identify_risks", label: "识别风险点" },
  { node: "generate_questions", label: "生成面试题" },
  { node: "generate_tips", label: "生成准备建议" },
];

function AnalysisProgress({ progress }: { progress: StreamAnalysisProgress | null }) {
  const completed = progress?.completed || [];
  const completedNodes = new Set(completed.map((c) => c.node));
  // current 仅对"未在 completed 列表中"的节点生效,避免同一节点同时显示已完成和进行中
  const currentLabel = progress?.current || null;

  return (
    <div className="space-y-2">
      {TOTAL_NODES.map((item, idx) => {
        const isDone = completedNodes.has(item.node);
        // 已完成节点不再判定为 current
        const isCurrent = !isDone && currentLabel === item.label;
        const isPending = !isDone && !isCurrent;

        return (
          <div
            key={item.node}
            className="card p-3 flex items-center gap-3 transition-all"
            style={{
              opacity: isPending ? 0.5 : 1,
              background: isDone
                ? "var(--success-soft)"
                : isCurrent
                  ? "var(--accent-bg)"
                  : "var(--bg-elevated)",
            }}
          >
            {/* 状态图标 */}
            <div className="shrink-0">
              {isDone ? (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ background: "var(--success)" }}
                >
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              ) : isCurrent ? (
                <div className="w-7 h-7 rounded-full border-2 border-orange-300 border-t-orange-600 animate-spin" />
              ) : (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-semibold"
                  style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}
                >
                  {idx + 1}
                </div>
              )}
            </div>

            {/* 节点信息 */}
            <div className="flex-1 min-w-0">
              <div
                className="text-[13px] font-medium"
                style={{
                  color: isDone ? "var(--success)" : isCurrent ? "var(--accent)" : "var(--fg-muted)",
                }}
              >
                {item.label}
              </div>
              {isCurrent && (
                <div className="text-[11px] text-stone-500 mt-0.5">进行中…</div>
              )}
              {isDone && (
                <div className="text-[11px] text-stone-500 mt-0.5">已完成</div>
              )}
            </div>

            {/* 节点序号 */}
            <div className="text-[11px] text-stone-400 shrink-0">
              {idx + 1} / {TOTAL_NODES.length}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 匹配度卡片 ──
function MatchScoreCard({ analysis }: { analysis: InterviewResult["match_analysis"] }) {
  const score = analysis.match_score || 0;
  const level = scoreColor(score);
  const levelText = score >= 80 ? "高度匹配" : score >= 60 ? "基本匹配" : score >= 40 ? "勉强匹配" : "差距较大";
  const levelColor =
    level === "success" ? "var(--success)" : level === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div className="card p-6 mb-6" style={{ background: "var(--bg-elevated)" }}>
      <div className="flex items-center gap-6">
        {/* 分数环 */}
        <div className="relative w-24 h-24 shrink-0">
          <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="8" />
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke={levelColor}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${(score / 100) * 264} 264`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[26px] font-bold" style={{ color: levelColor }}>
              {score}
            </div>
            <div className="text-[10px] text-stone-400">/ 100</div>
          </div>
        </div>
        <div className="flex-1">
          <div className="text-[16px] font-semibold text-stone-800 mb-1">{levelText}</div>
          <div className="text-[12px] text-stone-500 leading-relaxed">
            综合评估你的简历与岗位 JD 的匹配程度,分数仅供参考,具体请结合下方改进点优化。
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 报告主体(内联展示与全屏预览共用) ──
function ReportBody({ result }: { result: InterviewResult }) {
  return (
    <>
      {/* 匹配度 */}
      <MatchScoreCard analysis={result.match_analysis} />

      {/* 改进点 */}
      {result.match_analysis.improvement_points.length > 0 && (
        <Section title="需要提升的改进点" icon="💡">
          <ul className="space-y-2">
            {result.match_analysis.improvement_points.map((p, i) => (
              <li
                key={i}
                className="flex gap-3 p-3 rounded-lg text-[13px]"
                style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
              >
                <span className="font-semibold">{i + 1}.</span>
                <span className="flex-1">{p}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 强项 / 弱项 / 未提及 */}
      <Section title="匹配详情" icon="🔍">
        <div className="grid grid-cols-3 gap-3">
          <PointsCard
            title="强匹配"
            items={result.match_analysis.strong_points}
            variant="success"
          />
          <PointsCard
            title="需补强"
            items={result.match_analysis.weak_points}
            variant="warning"
          />
          <PointsCard
            title="未提及"
            items={result.match_analysis.not_mentioned}
            variant="danger"
          />
        </div>
      </Section>

      {/* 面试题 */}
      <Section title={`面试题推演(${result.questions.rounds.length} 轮)`} icon="❓">
        <div className="space-y-3">
          {result.questions.rounds.map((round, i) => (
            <RoundCard key={i} round={round} roundIndex={i} />
          ))}
        </div>
      </Section>

      {/* 业务场景 */}
      {result.business_scenarios.length > 0 && (
        <Section title="业务场景推演" icon="🎯">
          <div className="space-y-2">
            {result.business_scenarios.map((s, i) => (
              <div key={i} className="card p-3 text-[13px]">
                <div className="font-semibold text-stone-800 mb-1">{s.scenario}</div>
                <div className="text-stone-600 text-[12px] mb-1">
                  <span className="text-stone-400">问题:</span> {s.inferred_problem}
                </div>
                <div className="text-stone-600 text-[12px]">
                  <span className="text-stone-400">切入角度:</span> {s.interview_angle}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 备考建议 */}
      {result.preparation_tips && result.preparation_tips.length > 0 && (
        <Section title="备考建议" icon="📚">
          <ul className="space-y-1.5">
            {result.preparation_tips.map((t, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-stone-700">
                <span className="text-orange-600">•</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ── 通用 Section ──
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="section-title">
        {icon && <span className="text-[16px]">{icon}</span>}
        {title}
      </div>
      {children}
    </div>
  );
}

function PointsCard({
  title,
  items,
  variant,
}: {
  title: string;
  items: string[];
  variant: "success" | "warning" | "danger";
}) {
  const colorMap = {
    success: { bg: "var(--success-soft)", color: "var(--success)" },
    warning: { bg: "var(--warning-soft)", color: "var(--warning)" },
    danger: { bg: "var(--danger-soft)", color: "var(--danger)" },
  };
  const c = colorMap[variant];
  return (
    <div className="p-3 rounded-lg" style={{ background: c.bg, color: c.color }}>
      <div className="text-[12px] font-semibold mb-2">{title}</div>
      {items.length === 0 ? (
        <div className="text-[12px] opacity-60">—</div>
      ) : (
        <ul className="space-y-1 text-[12px]">
          {items.map((it, i) => (
            <li key={i} className="leading-relaxed">• {it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 一轮面试题 ──
function RoundCard({ round, roundIndex }: { round: InterviewRound; roundIndex: number }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  return (
    <div className="card overflow-hidden">
      <div
        className="px-4 py-3 flex items-center gap-3"
        style={{ background: "var(--accent-bg)", borderBottom: "1px solid var(--border)" }}
      >
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold text-white"
          style={{ background: "var(--accent)" }}
        >
          {roundIndex + 1}
        </div>
        <div className="flex-1">
          <div className="text-[14px] font-semibold text-stone-800">{round.round_name}</div>
          {round.round_focus && (
            <div className="text-[11px] text-stone-500 mt-0.5">{round.round_focus}</div>
          )}
        </div>
        <span className="badge badge-muted">{round.questions.length} 题</span>
      </div>
      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {round.questions.map((q, i) => (
          <QuestionItem
            key={i}
            q={q}
            index={i}
            open={openIdx === i}
            onToggle={() => setOpenIdx(openIdx === i ? null : i)}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionItem({
  q,
  index,
  open,
  onToggle,
}: {
  q: Question;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="px-4 py-3" style={{ background: open ? "var(--bg-muted)" : "var(--bg-elevated)" }}>
      <button onClick={onToggle} className="w-full text-left flex items-start gap-3">
        <span className="text-[11px] text-stone-400 font-mono shrink-0 pt-0.5">Q{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-stone-800">{q.title}</div>
          <div className="text-[12px] text-stone-600 mt-1 leading-relaxed">{q.question}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {q.difficulty && <span className="badge badge-warning">{q.difficulty}</span>}
          <svg
            className={`w-4 h-4 text-stone-400 transition ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="mt-3 ml-8 space-y-3 fade-in">
          {q.focus && (
            <DetailItem label="考察点" content={q.focus} variant="muted" />
          )}
          {q.rationale && (
            <DetailItem label="为什么会出这个题" content={q.rationale} variant="info" />
          )}
          {q.reference_answer && (
            <DetailItem label="基于简历的参考答案" content={q.reference_answer} variant="accent" />
          )}
          {q.follow_ups && q.follow_ups.length > 0 && (
            <div>
              <div className="text-[11px] text-stone-500 font-semibold mb-1.5">可能的追问</div>
              <div className="flex flex-wrap gap-1.5">
                {q.follow_ups.map((f, i) => (
                  <span key={i} className="badge badge-muted">{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailItem({
  label,
  content,
  variant,
}: {
  label: string;
  content: string;
  variant: "muted" | "info" | "accent";
}) {
  const colorMap = {
    muted: { bg: "var(--bg-muted)", color: "var(--fg-muted)", label: "var(--fg-subtle)" },
    info: { bg: "var(--info-soft)", color: "var(--info)", label: "var(--info)" },
    accent: { bg: "var(--accent-bg)", color: "var(--accent)", label: "var(--accent)" },
  };
  const c = colorMap[variant];
  return (
    <div className="p-3 rounded-lg" style={{ background: c.bg }}>
      <div className="text-[11px] font-semibold mb-1" style={{ color: c.label }}>{label}</div>
      <div className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: c.color }}>
        {content}
      </div>
    </div>
  );
}

// ── 把结构化简历转成文本(兜底)──
function buildResumeText(
  data: {
    basics: { name: string; phone: string; email: string; location: string; title: string; summary: string };
    education: { school: string; major: string; degree: string; start: string; end: string; description: string }[];
    experiences: { company: string; position: string; start: string; end: string; description: string }[];
    projects: { name: string; role: string; start: string; end: string; description: string; tech_stack: string[] }[];
    skills: { category: string; items: string[] }[];
  },
  fallbackName: string,
): string {
  const lines: string[] = [];
  const b = data.basics;
  lines.push(`# ${b.name || fallbackName}`);
  if (b.title) lines.push(`职位:${b.title}`);
  if (b.phone) lines.push(`电话:${b.phone}`);
  if (b.email) lines.push(`邮箱:${b.email}`);
  if (b.location) lines.push(`所在地:${b.location}`);
  if (b.summary) lines.push(`\n个人简介:${b.summary}`);

  if (data.education.length > 0) {
    lines.push("\n## 教育经历");
    data.education.forEach((e) => {
      lines.push(`- ${e.school} ${e.major} ${e.degree} (${e.start}-${e.end})`);
      if (e.description) lines.push(`  ${e.description}`);
    });
  }
  if (data.experiences.length > 0) {
    lines.push("\n## 工作经历");
    data.experiences.forEach((e) => {
      lines.push(`- ${e.company} ${e.position} (${e.start}-${e.end})`);
      if (e.description) lines.push(`  ${e.description}`);
    });
  }
  if (data.projects.length > 0) {
    lines.push("\n## 项目经历");
    data.projects.forEach((p) => {
      lines.push(`- ${p.name} ${p.role} (${p.start}-${p.end})`);
      if (p.description) lines.push(`  ${p.description}`);
      if (p.tech_stack.length > 0) lines.push(`  技术栈:${p.tech_stack.join(", ")}`);
    });
  }
  if (data.skills.length > 0) {
    lines.push("\n## 技能");
    data.skills.forEach((s) => {
      lines.push(`- ${s.category}: ${s.items.join(", ")}`);
    });
  }
  return lines.join("\n");
}

// ── 简历解析预览 ──
// 选中已保存简历或上传 Word/PDF 后,展示解析出的结构化信息,
// 让用户核对是否准确。data 为空时降级显示纯文本前几行。

function ResumeParsePreview({
  data,
  text,
}: {
  data: ResumeData | null;
  text: string;
}) {
  const [expanded, setExpanded] = useState(true);

  // 降级:无结构化数据,显示纯文本片段
  if (!data) {
    const snippet = text.trim().split("\n").slice(0, 8).join("\n");
    return (
      <div
        className="mt-3 rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border)" }}
      >
        <PreviewHeader
          title="解析预览(纯文本)"
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          warning
        />
        {expanded && (
          <div
            className="px-3 py-2 text-[11px] text-stone-500 whitespace-pre-wrap max-h-48 overflow-y-auto"
            style={{ background: "var(--bg-muted)" }}
          >
            {snippet || "(空)"}
            {text.trim().split("\n").length > 8 && "\n…"}
          </div>
        )}
      </div>
    );
  }

  // 有结构化数据,渲染基本信息 + 教育 + 工作 + 项目 + 技能
  const b = data.basics;
  const contactParts = [b.phone, b.email, b.location].filter(Boolean);
  const totalItems =
    data.education.length +
    data.experiences.length +
    data.projects.length +
    data.skills.length;

  return (
    <div
      className="mt-3 rounded-lg overflow-hidden"
      style={{ border: "1px solid var(--border)" }}
    >
      <PreviewHeader
        title={`解析预览 · ${totalItems} 项信息`}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />

      {expanded && (
        <div
          className="px-3 py-2.5 space-y-2.5 max-h-[360px] overflow-y-auto"
          style={{ background: "var(--bg-elevated)" }}
        >
          {/* 基本信息 */}
          <div>
            <div className="text-[12px] font-semibold text-stone-800">
              {b.name || "未识别姓名"}
              {b.title && <span className="text-stone-500 font-normal ml-1.5">· {b.title}</span>}
            </div>
            {contactParts.length > 0 && (
              <div className="text-[10.5px] text-stone-500 mt-0.5">{contactParts.join("  ·  ")}</div>
            )}
            {b.summary && (
              <div className="text-[11px] text-stone-600 mt-1 leading-relaxed line-clamp-2">
                {b.summary}
              </div>
            )}
          </div>

          {/* 教育 */}
          {data.education.length > 0 && (
            <PreviewSection title="教育">
              {data.education.map((e, i) => (
                <li key={i} className="text-[11px] text-stone-700 leading-relaxed">
                  <span className="font-medium">{e.school || "—"}</span>
                  {e.major && <span className="text-stone-500"> · {e.major}</span>}
                  {e.degree && <span className="text-stone-400"> · {e.degree}</span>}
                  {(e.start || e.end) && (
                    <span className="text-stone-400 ml-1">({e.start}-{e.end})</span>
                  )}
                </li>
              ))}
            </PreviewSection>
          )}

          {/* 工作 */}
          {data.experiences.length > 0 && (
            <PreviewSection title="工作">
              {data.experiences.map((e, i) => (
                <li key={i} className="text-[11px] text-stone-700 leading-relaxed">
                  <span className="font-medium">{e.company || "—"}</span>
                  {e.position && <span className="text-stone-500"> · {e.position}</span>}
                  {(e.start || e.end) && (
                    <span className="text-stone-400 ml-1">({e.start}-{e.end})</span>
                  )}
                  {e.description && (
                    <div className="text-stone-500 mt-0.5 line-clamp-2">{e.description}</div>
                  )}
                </li>
              ))}
            </PreviewSection>
          )}

          {/* 项目 */}
          {data.projects.length > 0 && (
            <PreviewSection title="项目">
              {data.projects.map((p, i) => (
                <li key={i} className="text-[11px] text-stone-700 leading-relaxed">
                  <span className="font-medium">{p.name || "—"}</span>
                  {p.role && <span className="text-stone-500"> · {p.role}</span>}
                  {p.tech_stack && p.tech_stack.length > 0 && (
                    <span className="text-stone-400 ml-1">[{p.tech_stack.join(", ")}]</span>
                  )}
                  {p.description && (
                    <div className="text-stone-500 mt-0.5 line-clamp-2">{p.description}</div>
                  )}
                </li>
              ))}
            </PreviewSection>
          )}

          {/* 技能 */}
          {data.skills.length > 0 && (
            <PreviewSection title="技能">
              {data.skills.map((s, i) => (
                <li key={i} className="text-[11px] text-stone-700 leading-relaxed">
                  <span className="text-stone-500">{s.category}:</span>{" "}
                  <span>{s.items.join(" · ")}</span>
                </li>
              ))}
            </PreviewSection>
          )}

          {/* 核对提示 */}
          <div
            className="text-[10.5px] text-stone-400 pt-1.5 flex items-start gap-1"
            style={{ borderTop: "1px dashed var(--border)" }}
          >
            <svg className="w-3 h-3 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>请核对信息是否准确,如解析有误可重新上传或选择其他简历。</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewHeader({
  title,
  expanded,
  onToggle,
  warning,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  warning?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full px-3 py-2 flex items-center gap-2 text-left"
      style={{
        background: warning ? "var(--warning-soft)" : "var(--bg-muted)",
        borderBottom: expanded ? "1px solid var(--border)" : "none",
      }}
    >
      <svg
        className={`w-3.5 h-3.5 ${warning ? "text-amber-600" : "text-stone-400"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className={`flex-1 text-[11px] font-semibold ${warning ? "text-amber-700" : "text-stone-600"}`}>
        {title}
      </span>
      <svg
        className={`w-3.5 h-3.5 text-stone-400 transition ${expanded ? "rotate-180" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

function PreviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-400 mb-1">
        {title}
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}
