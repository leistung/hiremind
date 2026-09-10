"use client"; // 客户端组件:分析页有大量交互、SSE 流式与浏览器存储

// 引入 React hooks、路由参数与链接组件
import { useEffect, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
// 工具函数:报告下载 / 相对时间 / 评分配色
import { downloadReport, relativeTime, scoreColor } from "@/lib/utils";
import FullscreenPreview, { FullscreenButton } from "@/components/FullscreenPreview";
import ModelBadge from "@/components/ModelBadge";
// 引入分析相关类型
import type {
  AnalysisDetail, // 分析详情
  AnalysisResponse, // 启动分析响应
  InterviewResult, // 分析结果
  InterviewRound, // 面试轮次
  PositionListItem, // 职位列表项
  Question, // 面试题
  ResumeData, // 结构化简历数据
  ResumeListItem, // 简历列表项
  AnalysisSummary, // 分析记录摘要
  NodeIORecord, // 节点输入输出记录
  StreamAnalysisProgress, // 流式分析进度
} from "@/lib/types";

/**
 * 简历来源:三种状态。
 * - none:未选择
 * - selected:从简历库选择(带 id,可重新拉取)
 * - uploaded:本地上传解析(仅存文本与名称)
 */
type ResumeSource =
  | { kind: "none" }
  | { kind: "selected"; id: string; name: string; text: string; data: ResumeData | null }
  | { kind: "uploaded"; name: string; text: string; data: ResumeData | null };

// 持久化 key:用于跨页面切换/刷新恢复分析状态
const STATE_KEY = "hiremind:analysis-state-v1";

/** 持久化的分析页面状态快照。 */
interface PersistedState {
  analysisId: string; // 分析 ID
  running: boolean; // 是否运行中
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
  savedAt: number; // 保存时间
}

/**
 * 页面包装组件:Suspense 边界(useSearchParams 所需)。
 */
export default function AnalysisPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-stone-400">加载中…</div>}>
      <AnalysisPageInner />
    </Suspense>
  );
}

/**
 * 面试分析主页面:JD × 简历深度分析。
 *
 * 布局:左侧表单(岗位信息 + 简历来源 + 运行按钮),右侧报告(空态/进度/结果)。
 * 功能:
 * - 从职位库选职位自动填充表单,从简历库选简历或上传 Word/PDF 解析
 * - 启动分析后通过 SSE 实时接收节点进度,支持停止(标记 cancelled)
 * - 分析完成后可导出 Word/PDF、复制 analysis_id、跳转模拟面试
 * - 全程 sessionStorage 持久化:切页/刷新自动恢复(30 分钟内)
 */
function AnalysisPageInner() {
  // ── 表单状态 ──
  const [companyName, setCompanyName] = useState(""); // 公司名称
  const [businessScope, setBusinessScope] = useState(""); // 业务范围
  const [jobTitle, setJobTitle] = useState(""); // 职位名称
  const [jobRequirements, setJobRequirements] = useState(""); // 岗位要求/JD
  const [resumes, setResumes] = useState<ResumeListItem[]>([]); // 简历库列表
  const [positions, setPositions] = useState<PositionListItem[]>([]); // 职位库列表
  const [selectedPositionId, setSelectedPositionId] = useState(""); // 选中的职位 ID
  const [resumeSource, setResumeSource] = useState<ResumeSource>({ kind: "none" }); // 简历来源
  const [loadingResumeText, setLoadingResumeText] = useState(false); // 正在加载简历文本
  const [parsingResume, setParsingResume] = useState(false); // 正在解析上传简历
  const fileRef = useRef<HTMLInputElement>(null); // 隐藏的文件选择框
  const searchParams = useSearchParams(); // URL 参数

  // ── 结果状态 ──
  const [result, setResult] = useState<InterviewResult | null>(null); // 分析结果
  const [analysisId, setAnalysisId] = useState(""); // 分析 ID
  const [running, setRunning] = useState(false); // 是否运行中
  const [error, setError] = useState(""); // 错误信息
  const [exporting, setExporting] = useState(""); // 正在导出的格式("word"/"pdf"/"")
  const [fullscreen, setFullscreen] = useState(false); // 全屏开关
  // 流式进度:已完成节点 + 当前节点
  const [progress, setProgress] = useState<StreamAnalysisProgress | null>(null);
  const [nodeIO, setNodeIO] = useState<NodeIORecord[]>([]); // 节点输入输出(可点击查看)
  // 本次分析启动时使用的模型(从后端 response/detail 读取,运行中不随全局配置变化)
  const [analysisModel, setAnalysisModel] = useState("");

  // 恢复标记:仅初始化时读取一次 sessionStorage
  const [restored, setRestored] = useState(false);
  // SSE abort 函数:组件卸载或新一轮分析时调用,断开旧连接
  const streamAbortRef = useRef<(() => void) | null>(null);

  // ── 分析记录管理 ──
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]); // 历史分析列表
  const [loadingAnalyses, setLoadingAnalyses] = useState(false); // 列表加载中
  const [deletingAnalysisId, setDeletingAnalysisId] = useState(""); // 正在删除的 ID

  // ── 初始化:读取 sessionStorage 恢复上次未完成的分析 ──
  useEffect(() => {
    if (restored) return; // 已恢复则跳过
    setRestored(true); // 标记已尝试恢复
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return; // 无快照
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
            r.resume.raw_text || // 优先原始文本
            buildResumeText(r.resume.data, r.resume.name); // 兜底:结构化转文本
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
        // 上传的简历:直接恢复快照(本地数据未保存)
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
          streamAnalysisResult(ps.analysisId); // 重新订阅 SSE
        } else {
          // 无 analysisId:状态失效
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

  // ── 进入空状态(无结果且未运行)时自动加载分析列表 ──
  useEffect(() => {
    if (!result && !running && analyses.length === 0 && !loadingAnalyses) {
      loadAnalyses(); // 拉取历史分析
    }
  }, [result, running]);

  // ── 持久化:running / result / analysisId / 表单 任一变化时同步到 sessionStorage ──
  // 用 ref 保存 analysisStartedAt,避免它变化触发持久化 effect(它只在 runAnalysis 时设置)
  const analysisStartedAtRef = useRef<number>(0);
  useEffect(() => {
    if (!restored) return; // 初始化未完成不写
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
    // 组装快照
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
      result: running ? null : result, // 运行中不存结果
      savedAt: Date.now(),
    };
    try {
      if (analysisId || result || running || resumeSource.kind !== "none") {
        sessionStorage.setItem(STATE_KEY, JSON.stringify(ps)); // 有内容才写
      } else {
        // 状态空了,清掉避免下次恢复空白
        sessionStorage.removeItem(STATE_KEY);
        analysisStartedAtRef.current = 0;
      }
    } catch {}
    // 依赖:恢复标记 + 所有参与快照的状态
  }, [restored, analysisId, running, result, companyName, businessScope, jobTitle, jobRequirements, selectedPositionId, resumeSource]);

  // ── 流式接收分析进度:SSE 推送节点完成事件,实时更新 progress state ──
  // knownAid:已知的 analysisId
  function streamAnalysisResult(knownAid: string) {
    // 断开旧连接
    if (streamAbortRef.current) {
      streamAbortRef.current();
      streamAbortRef.current = null;
    }
    setProgress({ completed: [], current: null }); // 重置进度
    const abort = api.streamAnalysis(knownAid, (payload) => {
      if (payload.progress) {
        setProgress(payload.progress); // 更新进度
        // 同步更新 nodeIO,让进行中的节点卡片可点击查看实时输出
        if (payload.node_io) {
          setNodeIO(payload.node_io);
        }
      }
      if (payload.status === "completed" && payload.result) {
        // 分析完成:写入结果
        setResult(payload.result);
        setAnalysisId(knownAid);
        setRunning(false); // 结束运行
        setError(""); // 清空错误
        setNodeIO(payload.node_io || []); // 保留节点输出
        streamAbortRef.current = null;
      } else if (payload.status === "error") {
        // 业务失败
        setRunning(false);
        setError(payload.error || "分析失败");
        setProgress(null);
        streamAbortRef.current = null;
      } else if (payload.status === "cancelled") {
        // 已取消
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
    streamAbortRef.current = abort; // 保存 abort 函数
  }

  // ── 组件卸载时断开 SSE 连接 ──
  useEffect(() => {
    return () => {
      if (streamAbortRef.current) {
        streamAbortRef.current(); // 断开
        streamAbortRef.current = null;
      }
    };
  }, []);

  // ── 初始化时加载简历库与职位库 ──
  useEffect(() => {
    api.listResumes().then((r) => setResumes(r.resumes || [])).catch(() => {});
    api.listPositions().then((r) => setPositions(r.positions || [])).catch(() => {});
  }, []);

  // ── 从 URL 参数预选职位 (?position=id) ──
  const pid = searchParams.get("position");
  useEffect(() => {
    // 职位列表加载完成且未手动选择时,按 URL 参数预选
    if (pid && positions.length > 0 && !selectedPositionId) {
      selectPosition(pid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, positions]);

  /**
   * 从简历库选择简历:拉取完整文本与结构化数据。
   */
  async function selectResume(id: string) {
    invalidateResult(); // 输入变化,作废旧结果
    if (!id) {
      setResumeSource({ kind: "none" }); // 清空选择
      return;
    }
    const item = resumes.find((r) => r.id === id); // 从列表找元信息
    if (!item) return;
    setLoadingResumeText(true); // 进入加载态
    try {
      const r = await api.getResume(id); // 拉取简历详情
      const text =
        r.resume.raw_text ||
        buildResumeText(r.resume.data, r.resume.name); // 兜底转文本
      setResumeSource({
        kind: "selected",
        id,
        name: item.basics_name || item.name, // 展示名
        text,
        data: r.resume.data,
      });
    } catch {
      setError("加载简历失败");
    } finally {
      setLoadingResumeText(false);
    }
  }

  /**
   * 从职位库选择职位:自动填充表单(不覆盖已填的非空字段)。
   */
  async function selectPosition(id: string) {
    invalidateResult(); // 输入变化,作废旧结果
    if (!id) {
      setSelectedPositionId(""); // 清空选择
      return;
    }
    try {
      const r = await api.getPosition(id); // 拉取职位详情
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

  /**
   * 上传并解析简历文件:调用后端解析,展示结构化预览。
   */
  async function handleUpload(file: File) {
    setError("");
    setParsingResume(true); // 进入解析态
    try {
      const r = await api.uploadParseResume(file); // 上传解析
      if (!r.success || !r.text) {
        setError(r.error || "解析失败");
        return;
      }
      invalidateResult(); // 输入变化,作废旧结果
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
      setParsingResume(false); // 结束解析态
      if (fileRef.current) fileRef.current.value = ""; // 重置文件框,允许重选同一文件
    }
  }

  /**
   * 启动分析:校验输入 → 持久化 → 调用后端 → SSE 接收进度。
   */
  async function runAnalysis() {
    setError("");
    if (!jobRequirements.trim()) return setError("请填写岗位要求 / JD 正文"); // 必须填 JD
    if (resumeSource.kind === "none") return setError("请选择或上传简历"); // 必须有简历

    // 断开旧的 SSE 连接(如果有)
    if (streamAbortRef.current) {
      streamAbortRef.current();
      streamAbortRef.current = null;
    }
    const startedAt = Date.now(); // 记录开始时间
    analysisStartedAtRef.current = startedAt;
    setRunning(true); // 进入运行态
    setResult(null); // 清空旧结果
    setAnalysisId(""); // 清空旧 ID
    setProgress({ completed: [], current: null }); // 重置进度
    setNodeIO([]); // 清空节点输出
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
      const selectedPos = positions.find((p) => p.id === selectedPositionId); // 找职位名
      // 调用后端启动分析
      const r: AnalysisResponse = await api.runAnalysis({
        company_name: companyName,
        company_business_scope: businessScope,
        job_title: jobTitle,
        job_requirements: jobRequirements,
        resume: resumeSource.text, // 简历文本
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
      streamAnalysisResult(r.analysis_id); // 订阅 SSE
    } catch (e) {
      setError("请求失败,请检查后端服务是否正常运行。");
      setRunning(false);
    }
  }

  /**
   * 导出分析报告(Word/PDF)。
   */
  async function handleExport(format: "word" | "pdf") {
    if (!analysisId) return; // 无 ID 不导出
    setExporting(format); // 标记导出中
    try {
      const r = await api.exportAnalysisReport(format, analysisId); // 请求导出
      if (!r.success || !r.filename) {
        setError(r.error || "导出失败");
        return;
      }
      // 触发浏览器下载
      await downloadReport(r.filename, api.downloadUrl(r.filename));
    } catch {
      setError("导出失败");
    } finally {
      setExporting(""); // 结束导出态
    }
  }

  // 是否可启动:JD 非空 + 已选简历 + 未在运行
  const canRun =
    jobRequirements.trim() && resumeSource.kind !== "none" && !running;

  // 停止分析确认弹窗:点击「停止分析」只显示弹窗,不修改任何状态
  // 只有用户点击「确认停止」后才真正执行停止逻辑
  const [showStopConfirm, setShowStopConfirm] = useState(false);

  /**
   * 作废已有结果:当用户修改了任何输入(简历/JD/职位/公司等)时调用
   * 清掉 result 和 analysisId,让按钮回到「开始分析」状态,右侧回到空白
   * 但不清理表单输入本身——用户正在编辑,清表单会很反直觉
   */
  function invalidateResult() {
    if (result === null && analysisId === "" && progress === null) return; // 无结果可作废
    setResult(null); // 清结果
    setAnalysisId(""); // 清 ID
    setError(""); // 清错误
    setProgress(null); // 清进度
    setAnalysisModel(""); // 清模型
    analysisStartedAtRef.current = 0; // 清开始时间
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

  /** 请求停止:只弹窗,不动状态。 */
  function requestStop() {
    setShowStopConfirm(true);
  }

  /** 确认停止:真正执行停止逻辑。 */
  async function confirmStop() {
    setShowStopConfirm(false); // 关闭弹窗
    // 如果在弹窗期间分析已自然完成(running 已变 false),无需再停止
    if (!running) return;
    const aidToCancel = analysisId; // 记录要取消的 ID
    if (streamAbortRef.current) {
      streamAbortRef.current(); // 断开 SSE
      streamAbortRef.current = null;
    }
    setRunning(false); // 结束运行
    setResult(null); // 清结果
    setAnalysisId(""); // 清 ID
    setError(""); // 清错误
    setProgress(null); // 清进度
    setAnalysisModel(""); // 清模型
    analysisStartedAtRef.current = 0; // 清开始时间
    try {
      sessionStorage.removeItem(STATE_KEY); // 清持久化
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

  /** 取消停止:只关弹窗,状态完全不变。 */
  function cancelStop() {
    setShowStopConfirm(false);
  }

  // ── 分析记录管理:加载分析列表 ──
  async function loadAnalyses() {
    setLoadingAnalyses(true);
    try {
      const r = await api.listAnalyses();
      setAnalyses(r.analyses || []);
    } catch {
      setAnalyses([]); // 失败置空
    } finally {
      setLoadingAnalyses(false);
    }
  }

  // ── 分析记录管理:加载某条分析的结果 ──
  async function loadAnalysisResult(aid: string) {
    try {
      const r = await api.getAnalysis(aid); // 拉取详情
      if (r.status === "completed" && r.result) {
        // 已完成:恢复结果
        setResult(r.result);
        setAnalysisId(aid);
        setAnalysisModel(r.model || "");
        setNodeIO(r.node_io || []);
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

  // ── 分析记录管理:删除分析 ──
  async function deleteAnalysis(aid: string) {
    if (!confirm("确定删除该分析?删除后不可恢复。")) return; // 浏览器确认
    setDeletingAnalysisId(aid); // 标记删除中
    try {
      await api.deleteAnalysis(aid); // 调用后端删除
      setAnalyses((prev) => prev.filter((a) => a.id !== aid)); // 本地移除
    } catch {
      setError("删除分析失败");
    } finally {
      setDeletingAnalysisId("");
    }
  }

  return (
    // 页面布局:左右分栏
    <div className="flex h-screen">
      {/* ═══ 左侧:表单 ═══ */}
      <div
        className="w-[440px] shrink-0 flex flex-col border-r overflow-y-auto"
        style={{ background: "var(--bg-sidebar)", borderColor: "var(--border)" }}
      >
        {/* 页头说明 */}
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
          {/* ── 岗位信息卡片 ── */}
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
                // 职位库为空:引导去添加
                <div className="text-[12px] text-stone-400 py-1">
                  职位库为空,
                  <Link href="/positions" className="text-orange-700 hover:underline">
                    去添加职位 →
                  </Link>
                </div>
              ) : (
                // 职位下拉选择
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

            {/* 手动输入字段 */}
            <div className="space-y-3">
              {/* 公司名称 */}
              <div>
                <label className="label">公司名称(可选)</label>
                <input
                  className="input"
                  value={companyName}
                  onChange={(e) => {
                    setCompanyName(e.target.value);
                    invalidateResult(); // 输入变化作废结果
                  }}
                  placeholder="如:字节跳动(留空可仅按 JD 分析)"
                />
              </div>
              {/* 业务范围 */}
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
              {/* 职位名称 */}
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
              {/* JD 正文 */}
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

          {/* ── 简历来源卡片 ── */}
          <div className="card p-4">
            <div className="section-title">简历来源</div>
            <div className="space-y-3">
              {/* 从简历库选择 */}
              <div>
                <label className="label">从已保存的简历中选择</label>
                {resumes.length === 0 ? (
                  // 简历库为空:引导去创建
                  <div className="text-[12px] text-stone-400 py-2">
                    暂无简历,
                    <Link href="/resumes" className="text-orange-700">
                      去创建 →
                    </Link>
                  </div>
                ) : (
                  // 简历下拉选择
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

              {/* 分隔线:"或" */}
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
                <span className="text-[11px] text-stone-400">或</span>
                <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
              </div>

              {/* 上传简历按钮 + 隐藏文件输入 */}
              <button
                onClick={() => fileRef.current?.click()} // 触发隐藏文件框
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
                accept=".pdf,.doc,.docx,.txt,.md" // 支持格式
                className="hidden" // 隐藏输入框
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f); // 有文件才处理
                }}
              />
            </div>

            {/* 解析耗时说明 */}
            {!parsingResume && (
              <div className="text-[11px] text-stone-400 leading-relaxed -mt-1">
                上传后会调用 LLM 提取结构化信息,可能需要 1-5 分钟。如急需使用,可先在「简历库」手动创建。
              </div>
            )}

            {/* 当前选中状态:显示已选/已上传的简历名,可清除 */}
            {resumeSource.kind !== "none" && (
              <div
                className="mt-3 px-3 py-2 rounded-lg text-[12px] flex items-center gap-2"
                style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
              >
                {/* 对勾图标 */}
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {/* 简历名(超长截断) */}
                <span className="flex-1 truncate">
                  {resumeSource.kind === "selected" ? "已选简历:" : "已上传:"} {resumeSource.name}
                </span>
                {/* 清除按钮 */}
                <button
                  className="opacity-60 hover:opacity-100"
                  onClick={() => {
                    invalidateResult(); // 作废结果
                    setResumeSource({ kind: "none" }); // 清空来源
                  }}
                >
                  ×
                </button>
              </div>
            )}

            {/* 解析中提示 */}
            {parsingResume && (
              <div className="mt-3 p-3 rounded-lg text-[12px] text-stone-500 flex items-center gap-2" style={{ background: "var(--bg-muted)" }}>
                {/* 旋转圈 */}
                <div className="w-3.5 h-3.5 rounded-full border-2 border-orange-200 border-t-orange-600 animate-spin" />
                正在解析简历,提取结构化信息…
              </div>
            )}
            {/* 解析预览(上传后或选中后展示) */}
            {!parsingResume && resumeSource.kind !== "none" && (
              <ResumeParsePreview data={resumeSource.data} text={resumeSource.text} />
            )}
          </div>

          {/* ── 运行按钮区 ── */}
          {running ? (
            // 运行中:禁用按钮 + 停止按钮
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
            // 空闲:开始/重新分析按钮
            <button
              onClick={runAnalysis}
              disabled={!canRun} // 不满足启动条件禁用
              className="btn btn-primary w-full"
              style={{ padding: "10px 16px", fontSize: 14 }}
            >
              {result ? "重新分析" : "开始分析"}
            </button>
          )}

          {/* 运行中的提示文案 */}
          {running && (
            <div className="text-[11px] text-stone-400 leading-relaxed -mt-2">
              LLM 正在生成匹配度、改进点、面试题与参考答案。可切换到其他页面查看资料,返回时会自动恢复进度。如需立即重新分析,点击「停止分析」。
            </div>
          )}

          {/* 错误信息 */}
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

      {/* ═══ 右侧:报告区 ═══ */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {/* ── 空态:未运行且无结果 → 提示 + 分析记录管理 ── */}
        {!result && !running && (
          <div className="h-full flex flex-col">
            {/* 顶部提示 */}
            <div className="flex flex-col items-center justify-center py-10 text-stone-400">
              {/* 图表图标 */}
              <svg className="w-12 h-12 mb-3 opacity-40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div className="text-[14px]">完成左侧表单后,这里会显示分析报告</div>
              <div className="text-[12px] mt-1">或从下方分析记录中加载历史分析</div>
            </div>

            {/* 分析记录管理 */}
            <div className="flex-1 px-8 pb-8 overflow-y-auto">
              <div className="max-w-[720px] mx-auto">
                {/* 标题行 + 刷新按钮 */}
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
                  // 首次加载中
                  <div className="text-[13px] text-stone-400 py-8 text-center">加载中…</div>
                ) : analyses.length === 0 ? (
                  // 无记录
                  <div className="text-[13px] text-stone-400 py-8 text-center">
                    暂无分析记录,完成左侧表单后点击「开始分析」即可创建
                  </div>
                ) : (
                  // 记录列表
                  <div className="space-y-2">
                    {analyses.map((a) => (
                      <div
                        key={a.id}
                        className="card p-3 flex items-center gap-3 hover:shadow-sm transition-shadow"
                      >
                        <div className="flex-1 min-w-0">
                          {/* 记录标题:公司 · 岗位 */}
                          <div className="text-[13px] font-medium text-stone-700 truncate">
                            {a.company_name || a.title || "未命名分析"}
                            {a.job_title ? ` · ${a.job_title}` : ""}
                          </div>
                          {/* 元信息行:时间 + 状态 + 分数 + 消息数 */}
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
                        {/* 加载按钮 */}
                        <button
                          onClick={() => loadAnalysisResult(a.id)}
                          className="btn btn-secondary text-[12px]"
                          style={{ padding: "4px 12px" }}
                          title="加载该分析的报告"
                        >
                          加载
                        </button>
                        {/* 删除按钮 */}
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

        {/* ── 运行中:分析进度视图 ── */}
        {running && (
          <div className="h-full overflow-y-auto">
            <div className="max-w-[720px] mx-auto px-8 py-10">
              {/* 顶部标题:旋转圈 + 文案 + 模型徽章 */}
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
              <AnalysisProgress progress={progress} nodeIO={nodeIO} />
            </div>
          </div>
        )}

        {/* ── 有结果:报告视图 ── */}
        {result && !running && (
          <div className="max-w-[960px] mx-auto p-8 fade-in">
            {/* 报告头:标题 + 操作按钮 */}
            <div className="flex items-start justify-between mb-6">
              <div>
                <h1 className="text-[22px] font-semibold text-stone-800 mb-1">
                  {result.company_name || "未指定公司"} · {result.job_title || "未指定岗位"}
                </h1>
                <div className="text-[12px] text-stone-400">面试分析报告</div>
              </div>
              {/* 操作:全屏 / 导出 Word / 导出 PDF / 去模拟面试 */}
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
                {/* 携带分析 ID 去模拟面试 */}
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

      {/* ═══ 全屏预览 ═══ */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={result ? `${result.company_name || "未指定公司"} · ${result.job_title || "未指定岗位"}` : "面试分析报告"}
        subtitle="面试分析报告 · 按 Esc 退出"
        maxWidth={960}
      >
        {/* 全屏内容:复用报告主体 */}
        {result && <ReportBody result={result} />}
      </FullscreenPreview>

      {/* ═══ 停止分析确认弹窗 ═══ */}
      {showStopConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(28, 25, 23, 0.4)" }} // 半透明遮罩
          onClick={cancelStop} // 点击遮罩取消
        >
          <div
            className="rounded-2xl shadow-xl max-w-[400px] w-[90%] fade-in"
            style={{ background: "var(--bg-elevated)" }}
            onClick={(e) => e.stopPropagation()} // 阻止冒泡
          >
            <div className="p-5">
              {/* 弹窗头:警告图标 + 标题 */}
              <div className="flex items-center gap-3 mb-3">
                {/* 红色警告圆标 */}
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: "var(--danger-soft)" }}
                >
                  {/* 警告三角形图标 */}
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
              {/* 提示文案 */}
              <div className="text-[13px] text-stone-600 leading-relaxed mb-5">
                停止后,正在进行的分析将被中断。已填写的岗位信息与简历选择会保留,你可以修改后重新开始分析。
              </div>
              {/* 操作按钮 */}
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

// ─────────────────────────── analysis_id 显示条:点击复制,供用户粘贴到模拟面试页 ───────────────────────────

/**
 * 分析 ID 显示条:展示 analysis_id,点击复制到剪贴板。
 */
function AnalysisIdBar({ id }: { id: string }) {
  const [copied, setCopied] = useState(false); // 是否已复制

  /** 复制 ID 到剪贴板;失败时降级为选中文字。 */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(id); // 写剪贴板
      setCopied(true); // 显示"已复制"
      setTimeout(() => setCopied(false), 1500); // 1.5s 后复原
    } catch {
      // 降级:选中文字
      const range = document.createRange();
      const sel = window.getSelection();
      const el = document.getElementById(`aid-${id}`); // 定位 ID 元素
      if (el && sel) {
        range.selectNodeContents(el); // 选中内容
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  return (
    // 灰底圆角条
    <div
      className="px-4 py-3 rounded-lg flex items-center gap-3"
      style={{ background: "var(--bg-muted)", border: "1px solid var(--border)" }}
    >
      {/* 链接图标 */}
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
      {/* 标签 + ID */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-stone-500 mb-0.5">分析记录 ID(可用于模拟面试)</div>
        <div
          id={`aid-${id}`} // 供降级复制定位
          className="text-[12px] font-mono text-stone-700 truncate"
          title={id}
        >
          {id}
        </div>
      </div>
      {/* 复制按钮 */}
      <button
        onClick={handleCopy}
        className="btn btn-secondary text-[12px] shrink-0"
        style={{ padding: "5px 12px" }}
        title="复制 ID"
      >
        {copied ? (
          // 已复制状态:绿色对勾
          <span className="flex items-center gap-1" style={{ color: "var(--success)" }}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            已复制
          </span>
        ) : (
          // 默认状态:复制图标 + 文字
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

// ─────────────────────────── 分析进度展示:SSE 推送的已完成节点列表 ───────────────────────────

// 分析图节点分组(反映实际并行结构)
const NODE_GROUPS: { nodes: { node: string; label: string }[]; desc: string }[] = [
  {
    // 第一组:并行解析 JD 与简历
    nodes: [
      { node: "parse_jd", label: "解析岗位要求" },
      { node: "parse_resume", label: "解析简历" },
    ],
    desc: "并行解析",
  },
  {
    // 第二组:并行分析
    nodes: [
      { node: "analyze_match", label: "匹配度分析" },
      { node: "infer_scenarios", label: "推断业务场景" },
      { node: "identify_risks", label: "识别风险点" },
    ],
    desc: "并行分析",
  },
  {
    // 第三组:出题
    nodes: [{ node: "generate_questions", label: "生成面试题" }],
    desc: "出题",
  },
  {
    // 第四组:建议
    nodes: [{ node: "generate_tips", label: "生成准备建议" }],
    desc: "建议",
  },
];

/**
 * 分析进度视图:按 NODE_GROUPS 分组展示节点状态(完成/进行中/等待)。
 * 每组一个标签,组内节点并排;组与组之间用向下箭头连接。
 * 点击有 IO 输出的节点可查看详细输出弹窗。
 */
function AnalysisProgress({
  progress,
  nodeIO,
}: {
  progress: StreamAnalysisProgress | null;
  nodeIO: NodeIORecord[];
}) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null); // 选中的节点(弹窗)
  const completed = progress?.completed || []; // 已完成节点列表
  const completedNodes = new Set(completed.map((c) => c.node)); // 完成节点集合
  const selectedIO = nodeIO.find((r) => r.node === selectedNode); // 选中节点的 IO

  // 基于拓扑推断 isCurrent:某组 isCurrent 当且仅当该组未全完成且前面所有组都全完成
  // 不依赖后端 current 字段(它语义是"刚完成的节点",不是"进行中")
  const isGroupDone = (gIdx: number) =>
    NODE_GROUPS[gIdx].nodes.every((n) => completedNodes.has(n.node)); // 组内全完成
  const isGroupCurrent = (gIdx: number) => {
    // 本组未全完成
    if (isGroupDone(gIdx)) return false;
    // 前面所有组必须全完成
    for (let i = 0; i < gIdx; i++) {
      if (!isGroupDone(i)) return false;
    }
    return true;
  };

  return (
    <div className="space-y-3">
      {/* 逐组渲染 */}
      {NODE_GROUPS.map((group, gIdx) => {
        const groupDone = isGroupDone(gIdx); // 组是否完成
        const groupActive = isGroupCurrent(gIdx); // 组是否进行中

        return (
          <div key={gIdx}>
            {/* 组标签:按状态着色(绿完成/橙进行/灰等待) */}
            <div className="flex items-center gap-2 mb-1.5">
              <div
                className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                style={{
                  background: groupDone
                    ? "var(--success-soft)"
                    : groupActive
                      ? "var(--accent-bg)"
                      : "var(--bg-muted)",
                  color: groupDone
                    ? "var(--success)"
                    : groupActive
                      ? "var(--accent)"
                      : "var(--fg-muted)",
                }}
              >
                {group.desc}
              </div>
              {/* 完成组显示对勾 */}
              {groupDone && (
                <svg className="w-3 h-3" style={{ color: "var(--success)" }} fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            {/* 并行节点行:按组内节点数分列 */}
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: `repeat(${group.nodes.length}, minmax(0, 1fr))`,
              }}
            >
              {group.nodes.map((item) => {
                const isDone = completedNodes.has(item.node); // 已完成
                // isCurrent:所在组正在进行(前驱组全完成 && 本组未全完成)且自身未完成
                const isCurrent = !isDone && groupActive;
                const isPending = !isDone && !isCurrent; // 等待中
                const hasIO = nodeIO.some((r) => r.node === item.node); // 是否有 IO 可查看

                return (
                  <div
                    key={item.node}
                    onClick={() => {
                      if (hasIO) setSelectedNode(item.node); // 有 IO 才可点击
                    }}
                    className="card p-2.5 flex flex-col items-center gap-1.5 transition-all text-center"
                    style={{
                      opacity: isPending ? 0.45 : 1, // 等待中半透明
                      cursor: hasIO ? "pointer" : "default", // 可点击提示
                      background: isDone
                        ? "var(--success-soft)" // 完成:绿底
                        : isCurrent
                          ? "var(--accent-bg)" // 进行中:橙底
                          : "var(--bg-elevated)", // 等待中:白底
                      borderColor: isCurrent ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    {/* 状态图标:对勾 / 旋转圈 / 灰点 */}
                    <div className="shrink-0">
                      {isDone ? (
                        // 完成:绿底白对勾
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ background: "var(--success)" }}
                        >
                          <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      ) : isCurrent ? (
                        // 进行中:旋转圈
                        <div className="w-6 h-6 rounded-full border-2 border-orange-300 border-t-orange-600 animate-spin" />
                      ) : (
                        // 等待中:灰底灰点
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ background: "var(--bg-muted)" }}
                        >
                          <div className="w-2 h-2 rounded-full" style={{ background: "var(--fg-muted)" }} />
                        </div>
                      )}
                    </div>
                    {/* 节点标签 */}
                    <div
                      className="text-[11px] font-medium leading-tight"
                      style={{
                        color: isDone
                          ? "var(--success)"
                          : isCurrent
                            ? "var(--accent)"
                            : "var(--fg-muted)",
                      }}
                    >
                      {item.label}
                    </div>
                    {/* 状态文字 */}
                    <div className="text-[9px] text-stone-400">
                      {isDone ? "已完成" : isCurrent ? "进行中…" : "等待中"}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* 组间连接线:向下箭头 */}
            {gIdx < NODE_GROUPS.length - 1 && (
              <div className="flex justify-center my-1">
                <svg className="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </div>
            )}
          </div>
        );
      })}

      {/* ── 节点详情弹窗(点击有 IO 的节点打开) ── */}
      {selectedNode && selectedIO && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.4)" }} // 遮罩
          onClick={() => setSelectedNode(null)} // 点击遮罩关闭
        >
          <div
            className="rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden"
            style={{ background: "var(--bg-elevated, white)" }}
            onClick={(e) => e.stopPropagation()} // 阻止冒泡
          >
            {/* 弹窗头:节点名 + 关闭按钮 */}
            <div
              className="flex items-center justify-between px-4 py-3 border-b shrink-0"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex items-center gap-2">
                {/* 绿色对勾图标 */}
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center"
                  style={{ background: "var(--success)" }}
                >
                  <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  {/* 节点展示名 */}
                  <div className="text-sm font-semibold">{selectedIO.label}</div>
                  {/* 节点内部名(等宽) */}
                  <div className="text-[10px] text-stone-400 font-mono">{selectedIO.node}</div>
                </div>
              </div>
              {/* 关闭按钮 */}
              <button
                onClick={() => setSelectedNode(null)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100"
              >
                {/* X 图标 */}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* 弹窗内容:节点输出(结构化分行展示) */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="text-[11px] text-stone-400 mb-2">节点输出</div>
              {/* 输出内容容器(灰底,限高滚动) */}
              <div
                className="rounded-lg overflow-y-auto"
                style={{
                  background: "var(--bg-muted, #f5f5f4)",
                  maxHeight: "420px",
                }}
              >
                <NodeOutputView output={selectedIO.output} />
              </div>
            </div>
            {/* 弹窗底栏:完成时间 */}
            <div
              className="px-4 py-2 border-t text-[10px] text-stone-400 shrink-0"
              style={{ borderColor: "var(--border)" }}
            >
              完成时间:{selectedIO.ts}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── 节点输出结构化展示 ───────────────────────────
// 把 Python repr / JSON 字符串解析成分行展示,不同属性间有间距

// 从 Python repr 字符串中提取字段: field_name=value field2=value2
function parsePythonRepr(text: string): { key: string; raw: string }[] {
  const fields: { key: string; raw: string }[] = []; // 结果数组
  // 匹配 标识符= 的位置(排除字符串内部的等号)
  const regex = /([a-zA-Z_]\w*)=/g;
  const positions: { key: string; valueStart: number }[] = []; // 字段名与值起点
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    // 检查等号前是否在引号内(粗略:统计前面的引号数)
    const before = text.slice(0, match.index);
    const singleQuotes = (before.match(/'/g) || []).length; // 单引号数
    const doubleQuotes = (before.match(/"/g) || []).length; // 双引号数
    // 奇数引号说明在字符串内部,跳过
    if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1) continue;
    positions.push({ key: match[1], valueStart: match.index + match[0].length });
  }
  if (positions.length === 0) return [];
  // 按位置切分每个字段的值
  for (let i = 0; i < positions.length; i++) {
    const valueStart = positions[i].valueStart;
    // 值的结束位置:下一个字段名开始处(减去 key= 的长度)
    const valueEnd = i + 1 < positions.length
      ? positions[i + 1].valueStart - (positions[i + 1].key.length + 1)
      : text.length;
    let raw = text.slice(valueStart, valueEnd).trim();
    // 去掉末尾的多余空格和换行
    raw = raw.replace(/[\s]+$/, "");
    fields.push({ key: positions[i].key, raw });
  }
  return fields;
}

// 从 Python 列表字符串 ['a', 'b'] 中提取元素
function parsePythonList(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return []; // 非列表格式
  const inner = trimmed.slice(1, -1); // 去掉首尾括号
  // 按 ',' 分割,但要处理引号内的逗号
  const items: string[] = [];
  let current = ""; // 当前累积片段
  let inSingle = false, inDouble = false; // 引号状态
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; } // 单引号切换
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; } // 双引号切换
    if (ch === "," && !inSingle && !inDouble) {
      // 引号外的逗号:分割
      const item = current.trim();
      if (item) items.push(item);
      current = "";
    } else {
      current += ch; // 累积字符
    }
  }
  const last = current.trim();
  if (last) items.push(last); // 最后一段
  return items;
}

// 清理值的引号和转义
function cleanValue(raw: string): string {
  let v = raw.trim();
  // 去掉外层引号
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  // 反转义
  v = v.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, "\n");
  return v;
}

/** 节点输出视图:逐顶层字段渲染(字段名 + 值)。 */
function NodeOutputView({ output }: { output: Record<string, unknown> }) {
  const entries = Object.entries(output); // 顶层字段
  if (entries.length === 0) {
    return <div className="p-3 text-[12px] text-stone-400">(空)</div>;
  }
  return (
    <div className="p-3 space-y-4">
      {entries.map(([key, value], idx) => (
        <div key={idx}>
          {/* 顶层字段名:橙色加粗 + 下划线分隔 */}
          <div
            className="text-[11px] font-semibold mb-1.5 pb-1"
            style={{
              color: "var(--accent, #c2410c)",
              borderBottom: "1px solid var(--border, #e7e5e4)",
            }}
          >
            {key}
          </div>
          {/* 字段值(递归渲染) */}
          <FieldValue value={value} />
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染单个字段的值:支持 dict / list / string / number。
 * 递归处理嵌套结构,list 区分对象列表(卡片)与基本类型列表(bullet)。
 */
function FieldValue({ value }: { value: unknown }) {
  // null / undefined
  if (value === null || value === undefined) {
    return <div className="text-[11px] text-stone-400">—</div>;
  }

  // 字典:递归展示各字段
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <div className="text-[11px] text-stone-400">{"{}"}</div>;
    }
    return (
      <div className="space-y-2">
        {entries.map(([k, v], i) => (
          <SubField key={i} fieldKey={k} value={v} />
        ))}
      </div>
    );
  }

  // 列表
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="text-[11px] text-stone-400">{"[]"}</div>;
    }
    // 判断元素是否为对象(dict):是则用卡片样式,元素间有明显分隔
    const isObjectList = value.some(
      (item) => typeof item === "object" && item !== null && !Array.isArray(item)
    );
    if (isObjectList) {
      // 对象列表:逐卡片渲染
      return (
        <div className="space-y-3">
          {value.map((item, i) => (
            <div
              key={i}
              className="p-2.5 rounded-md"
              style={{
                background: "var(--bg-elevated, #ffffff)",
                border: "1px solid var(--border, #e7e5e4)",
              }}
            >
              <FieldValue value={item} />
            </div>
          ))}
        </div>
      );
    }
    // 基本类型列表:bullet 样式
    return (
      <ul className="space-y-1.5">
        {value.map((item, i) => (
          <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span className="shrink-0" style={{ color: "var(--accent, #c2410c)" }}>•</span>
            <div className="flex-1">
              <FieldValue value={item} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  // 纯文本 / 数字
  const text = String(value);
  // 如果是 Python repr 字符串(旧数据兼容),尝试解析
  if (typeof value === "string" && text.includes("=") && /[a-zA-Z_]\w*=/.test(text)) {
    const fields = parsePythonRepr(text); // 尝试提取字段
    if (fields.length > 0) {
      // 解析成功:逐字段展示
      return (
        <div className="space-y-2">
          {fields.map((f, i) => (
            <SubField key={i} fieldKey={f.key} rawValue={f.raw} />
          ))}
        </div>
      );
    }
  }
  // 普通文本直接展示(保留换行,超长断行)
  return (
    <div
      className="text-[11px] leading-relaxed whitespace-pre-wrap break-all"
      style={{ color: "var(--fg, #292524)" }}
    >
      {text}
    </div>
  );
}

/**
 * 子字段:字段名 + 值。
 * 支持结构化 value 与旧数据的 rawValue 字符串两种输入。
 */
function SubField({ fieldKey, value, rawValue }: { fieldKey: string; value?: unknown; rawValue?: string }) {
  // 优先用结构化 value,兼容旧数据的 rawValue 字符串
  const displayValue = value !== undefined ? value : rawValue;

  // ── 结构化值分支 ──
  if (value !== undefined) {
    // null:字段名 + 破折号
    if (value === null) {
      return (
        <div className="flex gap-2 text-[11px] leading-relaxed">
          <span className="font-medium text-stone-500 shrink-0">{fieldKey}:</span>
          <span className="text-stone-400">—</span>
        </div>
      );
    }
    // 数组
    if (Array.isArray(value)) {
      // 判断元素是否为对象(dict):是则用卡片样式
      const isObjectList = value.some(
        (item) => typeof item === "object" && item !== null && !Array.isArray(item)
      );
      return (
        <div>
          {/* 字段名 */}
          <div className="text-[10px] font-medium text-stone-500 mb-1">{fieldKey}</div>
          {value.length === 0 ? (
            <div className="text-[11px] text-stone-400 ml-2">{"[]"}</div>
          ) : isObjectList ? (
            // 对象列表:卡片样式
            <div className="space-y-2 ml-2">
              {value.map((item, i) => (
                <div
                  key={i}
                  className="p-2 rounded-md"
                  style={{
                    background: "var(--bg-elevated, #ffffff)",
                    border: "1px solid var(--border, #e7e5e4)",
                  }}
                >
                  <FieldValue value={item} />
                </div>
              ))}
            </div>
          ) : (
            // 基本类型列表:bullet
            <ul className="space-y-1 ml-2">
              {value.map((item, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
                  <span className="shrink-0" style={{ color: "var(--accent, #c2410c)" }}>•</span>
                  <div className="flex-1">
                    <FieldValue value={item} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    // 嵌套对象:递归渲染子字段
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      return (
        <div>
          <div className="text-[10px] font-medium text-stone-500 mb-1">{fieldKey}</div>
          <div className="ml-2 space-y-1.5">
            {entries.map(([k, v], i) => (
              <SubField key={i} fieldKey={k} value={v} />
            ))}
          </div>
        </div>
      );
    }
    // 基本类型:字段名 + 值
    return (
      <div className="flex gap-2 text-[11px] leading-relaxed">
        <span className="font-medium text-stone-500 shrink-0">{fieldKey}:</span>
        <span className="flex-1 whitespace-pre-wrap break-all" style={{ color: "var(--fg, #292524)" }}>
          {String(value)}
        </span>
      </div>
    );
  }

  // ── 旧数据兼容:rawValue 是字符串 ──
  const trimmed = (rawValue || "").trim();
  // 尝试解析 Python 列表
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const items = parsePythonList(trimmed);
    if (items.length > 0) {
      return (
        <div>
          <div className="text-[10px] font-medium text-stone-500 mb-1">{fieldKey}</div>
          <ul className="space-y-1 ml-2">
            {items.map((item, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
                <span className="shrink-0" style={{ color: "var(--accent, #c2410c)" }}>•</span>
                <span className="flex-1 whitespace-pre-wrap break-all">{cleanValue(item)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
  }
  // 普通字符串:字段名 + 清理后的值
  return (
    <div className="flex gap-2 text-[11px] leading-relaxed">
      <span className="font-medium text-stone-500 shrink-0">{fieldKey}:</span>
      <span className="flex-1 whitespace-pre-wrap break-all" style={{ color: "var(--fg, #292524)" }}>
        {cleanValue(trimmed)}
      </span>
    </div>
  );
}

// ─────────────────────────── 匹配度卡片 ───────────────────────────

/**
 * 匹配度评分卡片:SVG 环形进度环 + 等级文案。
 */
function MatchScoreCard({ analysis }: { analysis: InterviewResult["match_analysis"] }) {
  const score = analysis.match_score || 0; // 匹配度分数
  const level = scoreColor(score); // 语义色等级
  // 等级文案
  const levelText = score >= 80 ? "高度匹配" : score >= 60 ? "基本匹配" : score >= 40 ? "勉强匹配" : "差距较大";
  // 颜色映射
  const levelColor =
    level === "success" ? "var(--success)" : level === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div className="card p-6 mb-6" style={{ background: "var(--bg-elevated)" }}>
      <div className="flex items-center gap-6">
        {/* 分数环:底环 + 彩色进度环 */}
        <div className="relative w-24 h-24 shrink-0">
          <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
            {/* 灰色底环 */}
            <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="8" />
            {/* 彩色进度环:周长 ≈ 2π×42 ≈ 264 */}
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
          {/* 环中心:分数 + "/100" */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[26px] font-bold" style={{ color: levelColor }}>
              {score}
            </div>
            <div className="text-[10px] text-stone-400">/ 100</div>
          </div>
        </div>
        {/* 等级文案区 */}
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

// ─────────────────────────── 报告主体(内联展示与全屏预览共用) ───────────────────────────

/**
 * 分析报告主体:匹配度 + 改进点 + 匹配详情 + 面试题 + 业务场景 + 备考建议。
 * 内联与全屏预览共用,保证两处展示一致。
 */
function ReportBody({ result }: { result: InterviewResult }) {
  return (
    <>
      {/* 匹配度评分卡 */}
      <MatchScoreCard analysis={result.match_analysis} />

      {/* 改进点列表(琥珀底) */}
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

      {/* 强项 / 弱项 / 未提及 三列 */}
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

      {/* 面试题推演:按轮次渲染 */}
      <Section title={`面试题推演(${result.questions.rounds.length} 轮)`} icon="❓">
        <div className="space-y-3">
          {result.questions.rounds.map((round, i) => (
            <RoundCard key={i} round={round} roundIndex={i} />
          ))}
        </div>
      </Section>

      {/* 业务场景推演 */}
      {result.business_scenarios.length > 0 && (
        <Section title="业务场景推演" icon="🎯">
          <div className="space-y-2">
            {result.business_scenarios.map((s, i) => (
              <div key={i} className="card p-3 text-[13px]">
                {/* 场景名 */}
                <div className="font-semibold text-stone-800 mb-1">{s.scenario}</div>
                {/* 推测问题 */}
                <div className="text-stone-600 text-[12px] mb-1">
                  <span className="text-stone-400">问题:</span> {s.inferred_problem}
                </div>
                {/* 切入角度 */}
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

// ─────────────────────────── 通用 Section ───────────────────────────

/**
 * 报告区块容器:标题(带可选图标) + 内容。
 * @param title - 区块标题
 * @param icon - 可选标题图标(emoji)
 * @param children - 区块内容
 */
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
      {/* 标题行:图标 + 文字(复用 section-title 左侧橙色竖条样式) */}
      <div className="section-title">
        {icon && <span className="text-[16px]">{icon}</span>}
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * 匹配详情点卡片:标题 + 列表,按语义色(绿/黄/红)着色。
 */
function PointsCard({
  title,
  items,
  variant,
}: {
  title: string;
  items: string[];
  variant: "success" | "warning" | "danger";
}) {
  // 语义色映射表
  const colorMap = {
    success: { bg: "var(--success-soft)", color: "var(--success)" },
    warning: { bg: "var(--warning-soft)", color: "var(--warning)" },
    danger: { bg: "var(--danger-soft)", color: "var(--danger)" },
  };
  const c = colorMap[variant]; // 取当前变体颜色
  return (
    <div className="p-3 rounded-lg" style={{ background: c.bg, color: c.color }}>
      {/* 卡片标题 */}
      <div className="text-[12px] font-semibold mb-2">{title}</div>
      {/* 空态:破折号 */}
      {items.length === 0 ? (
        <div className="text-[12px] opacity-60">—</div>
      ) : (
        // 要点列表
        <ul className="space-y-1 text-[12px]">
          {items.map((it, i) => (
            <li key={i} className="leading-relaxed">• {it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────── 一轮面试题 ───────────────────────────

/**
 * 单轮面试题卡片:轮次标题栏 + 逐题折叠项。
 * 默认展开第一题(openIdx 初始为 0)。
 */
function RoundCard({ round, roundIndex }: { round: InterviewRound; roundIndex: number }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0); // 当前展开的题目下标
  return (
    <div className="card overflow-hidden">
      {/* 轮次标题栏:橙色底 + 轮次序号圆标 */}
      <div
        className="px-4 py-3 flex items-center gap-3"
        style={{ background: "var(--accent-bg)", borderBottom: "1px solid var(--border)" }}
      >
        {/* 轮次序号(橙色圆标) */}
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold text-white"
          style={{ background: "var(--accent)" }}
        >
          {roundIndex + 1}
        </div>
        <div className="flex-1">
          {/* 轮次名称 */}
          <div className="text-[14px] font-semibold text-stone-800">{round.round_name}</div>
          {/* 轮次侧重(可空) */}
          {round.round_focus && (
            <div className="text-[11px] text-stone-500 mt-0.5">{round.round_focus}</div>
          )}
        </div>
        {/* 题目数量徽章 */}
        <span className="badge badge-muted">{round.questions.length} 题</span>
      </div>
      {/* 题目列表:逐题渲染可折叠项 */}
      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {round.questions.map((q, i) => (
          <QuestionItem
            key={i}
            q={q}
            index={i}
            open={openIdx === i} // 是否展开
            onToggle={() => setOpenIdx(openIdx === i ? null : i)} // 点击切换
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 单道面试题折叠项:题目标题(点击展开) + 详细内容(考察点/出题分析/参考答案/追问)。
 */
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
      {/* 折叠标题按钮 */}
      <button onClick={onToggle} className="w-full text-left flex items-start gap-3">
        {/* 题号(等宽灰字) */}
        <span className="text-[11px] text-stone-400 font-mono shrink-0 pt-0.5">Q{index + 1}</span>
        <div className="flex-1 min-w-0">
          {/* 题目方向/标题 */}
          <div className="text-[13px] font-medium text-stone-800">{q.title}</div>
          {/* 题目正文 */}
          <div className="text-[12px] text-stone-600 mt-1 leading-relaxed">{q.question}</div>
        </div>
        {/* 右侧:难度徽章 + 展开箭头 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 难度徽章(可空) */}
          {q.difficulty && <span className="badge badge-warning">{q.difficulty}</span>}
          {/* 展开箭头:展开时旋转 180° */}
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
      {/* 展开后的详细内容 */}
      {open && (
        <div className="mt-3 ml-8 space-y-3 fade-in">
          {/* 考察点 */}
          {q.focus && (
            <DetailItem label="考察点" content={q.focus} variant="muted" />
          )}
          {/* 出题分析 */}
          {q.rationale && (
            <DetailItem label="为什么会出这个题" content={q.rationale} variant="info" />
          )}
          {/* 参考答案 */}
          {q.reference_answer && (
            <DetailItem label="基于简历的参考答案" content={q.reference_answer} variant="accent" />
          )}
          {/* 可能的追问(徽章列表) */}
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

/**
 * 详情信息项:标签 + 内容,按变体着色。
 * @param variant - muted(灰)/info(蓝)/accent(橙)
 */
function DetailItem({
  label,
  content,
  variant,
}: {
  label: string;
  content: string;
  variant: "muted" | "info" | "accent";
}) {
  // 变体颜色映射:背景 + 内容色 + 标签色
  const colorMap = {
    muted: { bg: "var(--bg-muted)", color: "var(--fg-muted)", label: "var(--fg-subtle)" },
    info: { bg: "var(--info-soft)", color: "var(--info)", label: "var(--info)" },
    accent: { bg: "var(--accent-bg)", color: "var(--accent)", label: "var(--accent)" },
  };
  const c = colorMap[variant]; // 取当前变体颜色
  return (
    <div className="p-3 rounded-lg" style={{ background: c.bg }}>
      {/* 标签(加粗小字) */}
      <div className="text-[11px] font-semibold mb-1" style={{ color: c.label }}>{label}</div>
      {/* 内容(保留换行) */}
      <div className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: c.color }}>
        {content}
      </div>
    </div>
  );
}

// ─────────────────────────── 把结构化简历转成文本(兜底) ───────────────────────────

/**
 * 把结构化简历数据转换为纯文本(Markdown 风格)。
 * 当后端没有返回 raw_text 时,用它生成简历文本用于分析。
 */
function buildResumeText(
  data: {
    basics: { name: string; phone: string; email: string; location: string; title: string; summary: string };
    education: { school: string; major: string; degree: string; start: string; end: string; description: string }[];
    experiences: { company: string; position: string; start: string; end: string; description: string }[];
    projects: { name: string; role: string; start: string; end: string; description: string; tech_stack: string[] }[];
    skills: { category: string; items: string[] }[];
  },
  fallbackName: string, // 无名时兜底
): string {
  const lines: string[] = []; // 行数组
  const b = data.basics;
  // 基本信息
  lines.push(`# ${b.name || fallbackName}`); // 姓名(标题)
  if (b.title) lines.push(`职位:${b.title}`);
  if (b.phone) lines.push(`电话:${b.phone}`);
  if (b.email) lines.push(`邮箱:${b.email}`);
  if (b.location) lines.push(`所在地:${b.location}`);
  if (b.summary) lines.push(`\n个人简介:${b.summary}`);

  // 教育经历
  if (data.education.length > 0) {
    lines.push("\n## 教育经历");
    data.education.forEach((e) => {
      lines.push(`- ${e.school} ${e.major} ${e.degree} (${e.start}-${e.end})`);
      if (e.description) lines.push(`  ${e.description}`);
    });
  }
  // 工作经历
  if (data.experiences.length > 0) {
    lines.push("\n## 工作经历");
    data.experiences.forEach((e) => {
      lines.push(`- ${e.company} ${e.position} (${e.start}-${e.end})`);
      if (e.description) lines.push(`  ${e.description}`);
    });
  }
  // 项目经历
  if (data.projects.length > 0) {
    lines.push("\n## 项目经历");
    data.projects.forEach((p) => {
      lines.push(`- ${p.name} ${p.role} (${p.start}-${p.end})`);
      if (p.description) lines.push(`  ${p.description}`);
      if (p.tech_stack.length > 0) lines.push(`  技术栈:${p.tech_stack.join(", ")}`);
    });
  }
  // 技能
  if (data.skills.length > 0) {
    lines.push("\n## 技能");
    data.skills.forEach((s) => {
      lines.push(`- ${s.category}: ${s.items.join(", ")}`);
    });
  }
  return lines.join("\n"); // 合并为完整文本
}

// ─────────────────────────── 简历解析预览 ───────────────────────────
// 选中已保存简历或上传 Word/PDF 后,展示解析出的结构化信息,
// 让用户核对是否准确。data 为空时降级显示纯文本前几行。

/**
 * 简历解析预览:展示解析出的结构化信息,可折叠。
 * data 为空时降级为纯文本片段。
 */
function ResumeParsePreview({
  data,
  text,
}: {
  data: ResumeData | null;
  text: string;
}) {
  const [expanded, setExpanded] = useState(true); // 默认展开

  // ── 降级分支:无结构化数据,显示纯文本片段 ──
  if (!data) {
    const snippet = text.trim().split("\n").slice(0, 8).join("\n"); // 前 8 行
    return (
      <div
        className="mt-3 rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--border)" }}
      >
        <PreviewHeader
          title="解析预览(纯文本)"
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          warning // 警示样式
        />
        {expanded && (
          <div
            className="px-3 py-2 text-[11px] text-stone-500 whitespace-pre-wrap max-h-48 overflow-y-auto"
            style={{ background: "var(--bg-muted)" }}
          >
            {snippet || "(空)"}
            {/* 超过 8 行显示省略提示 */}
            {text.trim().split("\n").length > 8 && "\n…"}
          </div>
        )}
      </div>
    );
  }

  // ── 有结构化数据分支:渲染基本信息 + 教育 + 工作 + 项目 + 技能 ──
  const b = data.basics;
  const contactParts = [b.phone, b.email, b.location].filter(Boolean); // 联系方式
  // 信息总条数(用于标题)
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
      {/* 折叠头:标题 + 展开箭头 */}
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
          {/* 基本信息:姓名 + 职位 + 联系方式 + 简介 */}
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

          {/* 教育经历 */}
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

          {/* 工作经历 */}
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

          {/* 项目经历 */}
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
            {/* 信息图标 */}
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

/**
 * 预览折叠头:标题 + 展开/收起箭头,可带警示样式。
 */
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
        background: warning ? "var(--warning-soft)" : "var(--bg-muted)", // 警示用琥珀底
        borderBottom: expanded ? "1px solid var(--border)" : "none",
      }}
    >
      {/* 文档图标 */}
      <svg
        className={`w-3.5 h-3.5 ${warning ? "text-amber-600" : "text-stone-400"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      {/* 标题 */}
      <span className={`flex-1 text-[11px] font-semibold ${warning ? "text-amber-700" : "text-stone-600"}`}>
        {title}
      </span>
      {/* 展开箭头:展开时旋转 180° */}
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

/**
 * 预览小节:小标题(大写英文风格) + 列表内容。
 */
function PreviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* 小节标题 */}
      <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-400 mb-1">
        {title}
      </div>
      {/* 列表内容(由调用方传入 li 元素) */}
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}
