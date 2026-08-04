// 后端 API 客户端：直连 FastAPI 后端(绕过 Next.js rewrites 代理的 30 秒超时限制)
// 优先用 NEXT_PUBLIC_API_BASE 环境变量,默认直连本地 8000 端口

import type {
  AnalysisDetail,
  AnalysisResponse,
  InterviewListItem,
  InterviewReport,
  InterviewReportDetail,
  InterviewState,
  InterviewTurn,
  ModelConfigRequest,
  ModelInfo,
  ModelTestRequest,
  ModelTestResponse,
  Position,
  PositionListItem,
  ReportFile,
  Resume,
  ResumeData,
  ResumeListItem,
  ResumeTemplate,
  AnalysisSummary,
  ExportResponse,
  StageConfig,
  StageRecommendResponse,
  StageSummary,
  StreamAnalysisEvent,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000/api";

async function postJson<T>(url: string, body: unknown, timeoutMs?: number): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  // 长耗时请求(如 LLM 分析)需要显式超时,否则浏览器/代理会在 ~2 分钟断开
  if (timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}${url}`, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ── 健康 ──
  health: () =>
    getJson<{ status: string; version: string; workspace: string }>("/health"),

  // ── 模型 ──
  getModelInfo: () => getJson<ModelInfo>("/models/info"),
  getBailianModels: () => getJson<{ models: string[] }>("/models/bailian"),
  updateModelConfig: (req: ModelConfigRequest) =>
    postJson<{ success: boolean; model: string }>("/models/config", req),
  testModelConnection: (req: ModelTestRequest) =>
    postJson<ModelTestResponse>("/models/test", req),

  // ── 文档解析 ──
  parseDocument: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/documents/parse`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<{
      success: boolean;
      text?: string;
      error?: string;
      filename?: string;
    }>;
  },

  // ── 简历 ──
  listResumeTemplates: () =>
    getJson<{ templates: Record<string, ResumeTemplate> }>("/resumes/templates"),

  listResumes: () =>
    getJson<{ resumes: ResumeListItem[] }>("/resumes"),

  getResume: (id: string) =>
    getJson<{ success: boolean; resume: Resume }>(`/resumes/${id}`),

  createResume: (body: {
    name?: string;
    data?: Partial<ResumeData>;
    raw_text?: string;
    template?: string;
  }) => postJson<{ success: boolean; resume: Resume }>("/resumes", body),

  updateResume: (
    id: string,
    body: {
      name?: string;
      data?: Partial<ResumeData>;
      raw_text?: string;
      template?: string;
    },
  ) => putJson<{ success: boolean; resume: Resume }>(`/resumes/${id}`, body),

  deleteResume: (id: string) =>
    del<{ success: boolean }>(`/resumes/${id}`),

  parseResumeText: (text: string) =>
    postJson<{ success: boolean; data?: ResumeData; error?: string }>(
      "/resumes/parse-text",
      { text },
    ),

  uploadParseResume: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    // LLM 结构化解析较慢(可能 1-5 分钟),设置 5 分钟超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      const res = await fetch(`${BASE}/resumes/upload-parse`, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        success: boolean;
        text?: string;
        data?: ResumeData;
        error?: string;
        filename?: string;
      }>;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  exportResume: (id: string, format: "word" | "pdf", template?: string) =>
    postJson<ExportResponse>(`/resumes/${id}/export`, { format, template }),

  uploadResumePhoto: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/resumes/${id}/photo`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<{
      success: boolean;
      photo?: string;
      error?: string;
    }>;
  },

  // ── 职位库 ──
  listPositions: () =>
    getJson<{ positions: PositionListItem[] }>("/positions"),
  getPosition: (id: string) =>
    getJson<{ success: boolean; position: Position }>(`/positions/${id}`),
  createPosition: (body: {
    name?: string;
    company_name?: string;
    company_business_scope?: string;
    job_title?: string;
    job_requirements?: string;
    notes?: string;
  }) =>
    postJson<{ success: boolean; position: Position }>("/positions", body),
  updatePosition: (id: string, body: {
    name?: string;
    company_name?: string;
    company_business_scope?: string;
    job_title?: string;
    job_requirements?: string;
    notes?: string;
  }) =>
    putJson<{ success: boolean; position: Position }>(`/positions/${id}`, body),
  deletePosition: (id: string) => del<{ success: boolean }>(`/positions/${id}`),

  // ── 分析 ──
  runAnalysis: (body: {
    company_name: string;
    company_business_scope: string;
    job_title: string;
    job_requirements: string;
    resume: string;
    resume_id?: string;
    resume_name?: string;
    position_id?: string;
    position_name?: string;
  }) => postJson<AnalysisResponse>("/analysis/run", body),

  getInterviewReport: (interview_id: string) =>
    getJson<InterviewReportDetail>(`/interview/${interview_id}/report`),

  // ── 分析记录管理 ──
  listAnalyses: () =>
    getJson<{ analyses: AnalysisSummary[] }>("/analyses"),

  getAnalysis: (analysis_id: string) =>
    getJson<AnalysisDetail>(`/analyses/${analysis_id}`),

  deleteAnalysis: (analysis_id: string) =>
    del<{ success: boolean }>(`/analyses/${analysis_id}`),

  cancelAnalysis: (analysis_id: string) =>
    postJson<{ success: boolean; status: string }>(`/analyses/${analysis_id}/cancel`, {}),

  // SSE 流式接收分析进度
  // onEvent: 收到一次 SSE 事件(payload 已 JSON 解析)
  // 返回一个 abort 函数,调用即断开连接
  streamAnalysis: (
    analysis_id: string,
    onEvent: (payload: StreamAnalysisEvent) => void,
  ): (() => void) => {
    const controller = new AbortController();
    const url = `${BASE}/analysis/stream/${analysis_id}`;

    (async () => {
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          onEvent({ error: `HTTP ${res.status}` });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE 事件以双换行分隔
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            // 解析 data: 行
            const lines = raw.split("\n");
            const dataLine = lines.find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const payload = JSON.parse(jsonStr) as StreamAnalysisEvent;
              onEvent(payload);
            } catch {
              // 忽略解析错误
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          onEvent({ error: (e as Error).message || "连接失败" });
        }
      }
    })();

    return () => controller.abort();
  },

  // ── 模拟面试 ──
  // 智能规划面试阶段方案:LLM 根据岗位/公司/期望轮次生成阶段配置
  recommendStages: (analysis_id: string, expected_rounds: number) =>
    postJson<StageRecommendResponse>("/interview/stages/recommend", {
      analysis_id,
      expected_rounds,
    }),

  startInterview: (
    analysis_id: string,
    max_turns = 8,
    stages?: StageConfig[],
  ) =>
    postJson<{
      success: boolean;
      state?: InterviewState;
      first_question?: string;
      error?: string;
    }>("/interview/start", { analysis_id, max_turns, stages: stages || [] }),

  submitInterviewAnswer: (interview_id: string, answer: string) =>
    postJson<{
      success: boolean;
      turn?: InterviewTurn;
      state?: InterviewState;
      error?: string;
    }>(`/interview/${interview_id}/answer`, { answer }),

  nextInterviewQuestion: (interview_id: string) =>
    postJson<{
      success: boolean;
      finished?: boolean;
      next_question?: string;
      report?: InterviewReport;
      stage_completed?: boolean;
      stage_summary?: StageSummary;
      state?: InterviewState;
      error?: string;
    }>(`/interview/${interview_id}/next`, {}),

  // 笔试批量提交
  submitWrittenAnswers: (interview_id: string, answers: Record<string, string>) =>
    postJson<{
      success: boolean;
      turns?: InterviewTurn[];
      stage_score?: number;
      stage_summary?: string;
      promotion_hint?: string;
      state?: InterviewState;
      error?: string;
    }>(`/interview/${interview_id}/written/submit`, { answers }),

  // 进入下一阶段(多阶段模式)
  advanceStage: (interview_id: string) =>
    postJson<{
      success: boolean;
      finished?: boolean;
      next_question?: string;
      written_ready?: boolean;
      report?: InterviewReport;
      state?: InterviewState;
      error?: string;
    }>(`/interview/${interview_id}/advance`, {}),

  finishInterview: (interview_id: string) =>
    postJson<{
      success: boolean;
      report?: InterviewReport;
      state?: InterviewState;
      error?: string;
    }>(`/interview/${interview_id}/finish`, {}),

  // 放弃面试:不生成报告,直接标记为 abandoned
  abandonInterview: (interview_id: string) =>
    postJson<{ success: boolean; status: string }>(
      `/interview/${interview_id}/abandon`,
      {},
    ),

  getInterviewState: (interview_id: string) =>
    getJson<{ success: boolean; state: InterviewState }>(
      `/interview/${interview_id}/state`,
    ),

  listInterviews: () =>
    getJson<{ interviews: InterviewListItem[] }>("/interview"),

  deleteInterview: (id: string) =>
    del<{ success: boolean }>(`/interview/${id}`),

  // ── 导出 ──
  exportAnalysisReport: (format: "word" | "pdf", analysis_id?: string) =>
    postJson<ExportResponse>("/export", { format, analysis_id }),

  listReports: () => getJson<{ reports: ReportFile[] }>("/export/list"),

  downloadUrl: (filename: string) =>
    `${BASE}/export/download/${encodeURIComponent(filename)}`,

  // 后端返回的照片/资源 URL 是相对路径(如 /api/assets/xxx.jpg),
  // 前端 BASE 已改为完整 URL,需要拼接前缀才能在 <img src> 中使用
  assetUrl: (path: string) => {
    if (!path) return "";
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    // path 形如 /api/assets/xxx.jpg,BASE 形如 http://127.0.0.1:8000/api
    // 去掉 BASE 末尾的 /api,加上完整 path
    const origin = BASE.replace(/\/api\/?$/, "");
    return `${origin}${path}`;
  },
};
