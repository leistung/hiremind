const BASE = "/api/workbench";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("hiremind_token");
  const response = await fetch(`${BASE}${path}`, { ...init, credentials: "include", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || body.error || `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}
const json = <T>(method: string, path: string, body?: unknown) => request<T>(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export type Resume = { id: string; name: string; raw_text: string; data: ResumeData; updated_at: string; basics_name?: string; basics_title?: string };
export type ResumeData = { basics: Record<string, string>; education: unknown[]; experiences: unknown[]; projects: unknown[]; skills: unknown[]; template: string };
export type Position = { id: string; name: string; company_name: string; company_business_scope: string; job_title: string; job_requirements: string; notes: string; updated_at: string };
export type Analysis = { analysis_id?: string; id?: string; title: string; status: string; result?: AnalysisResult | null; error?: string; updated_at?: string; metadata?: Record<string, string> };
export type AnalysisResult = { company_name: string; job_title: string; match_analysis: { match_score: number; strong_points: string[]; weak_points: string[]; not_mentioned: string[]; improvement_points: string[] }; business_scenarios: { scenario: string; inferred_problem: string; interview_angle: string }[]; risks: { risk_type: string; description: string; severity: string; suggested_question: string }[]; preparation_tips: string[] };
export type InterviewTurn = { question: string; answer: string; score: number; evaluation: string; improvements: string[] };
export type InterviewState = { interview_id: string; status: string; current_question?: string; turn_index: number; max_turns: number; turns: InterviewTurn[]; finished?: boolean; company_name: string; job_title: string };
export type InterviewListItem = { id: string; analysis_id: string; status: string; company_name: string; job_title: string; turns: number; created_at?: string; overall_score?: number; rounds_completed?: number; summary?: string; is_multi_stage?: boolean; stages_completed?: number };

export const api = {
  health: () => request<{ status: string }>("/health"),
  modelInfo: () => request<{ provider: string; model: string; api_key_configured: boolean; base_url: string }>("/models/info"),
  updateModel: (body: Record<string, string>) => json("POST", "/models/config", body),
  testModel: (body: Record<string, string>) => json<{ success: boolean; latency_ms?: number; reply?: string; error?: string }>("POST", "/models/test", body),
  resumes: () => request<{ resumes: Resume[] }>("/resumes"),
  resume: (id: string) => request<{ resume: Resume }>(`/resumes/${id}`),
  createResume: (body: Partial<Resume>) => json<{ resume: Resume }>("POST", "/resumes", body),
  updateResume: (id: string, body: Partial<Resume>) => json<{ resume: Resume }>("PUT", `/resumes/${id}`, body),
  deleteResume: (id: string) => request(`/resumes/${id}`, { method: "DELETE" }),
  parseResumeText: (text: string) => json<{ data?: ResumeData; error?: string }>("POST", "/resumes/parse-text", { text }),
  uploadParseResume: async (file: File) => { const form = new FormData(); form.append("file", file); return request<{ success: boolean; text?: string; data?: ResumeData; error?: string }>("/resumes/upload-parse", { method: "POST", body: form }); },
  exportResume: (id: string, format: "word" | "pdf") => json<{ success: boolean; filename?: string }>("POST", `/resumes/${id}/export`, { format }),
  positions: () => request<{ positions: Position[] }>("/positions"),
  position: (id: string) => request<{ position: Position }>(`/positions/${id}`),
  createPosition: (body: Partial<Position>) => json<{ position: Position }>("POST", "/positions", body),
  updatePosition: (id: string, body: Partial<Position>) => json<{ position: Position }>("PUT", `/positions/${id}`, body),
  deletePosition: (id: string) => request(`/positions/${id}`, { method: "DELETE" }),
  analyses: () => request<{ analyses: Analysis[] }>("/analyses"),
  analysis: (id: string) => request<Analysis>(`/analyses/${id}`),
  runAnalysis: (body: Record<string, string>) => json<{ analysis_id: string }>("POST", "/analysis/run", body),
  cancelAnalysis: (id: string) => json("POST", `/analyses/${id}/cancel`, {}),
  deleteAnalysis: (id: string) => request(`/analyses/${id}`, { method: "DELETE" }),
  interviews: () => request<{ interviews: InterviewListItem[] }>("/interview"),
  interviewState: (id: string) => request<{ state: InterviewState }>(`/interview/${id}/state`),
  startInterview: (analysis_id: string) => json<{ state: InterviewState }>("POST", "/interview/start", { analysis_id, max_turns: 8 }),
  answer: (id: string, answer: string) => json<{ state: InterviewState }>("POST", `/interview/${id}/answer`, { answer }),
  nextQuestion: (id: string) => json<{ state?: InterviewState; report?: unknown; finished?: boolean }>("POST", `/interview/${id}/next`, {}),
  finishInterview: (id: string) => json<{ state?: InterviewState; report?: unknown }>("POST", `/interview/${id}/finish`, {}),
  deleteInterview: (id: string) => request(`/interview/${id}`, { method: "DELETE" }),
  exportAnalysis: (format: "word" | "pdf", analysis_id?: string) => json<{ success: boolean; filename?: string }>("POST", "/export", { format, analysis_id }),
  downloadUrl: (filename: string) => `${BASE}/export/download/${encodeURIComponent(filename)}`,
  streamAnalysis(id: string, callback: (event: { status?: string; result?: AnalysisResult; error?: string; progress?: { completed?: { label: string }[]; current?: string } }) => void) {
    const controller = new AbortController();
    void (async () => { try { const res = await fetch(`${BASE}/analysis/stream/${id}`, { signal: controller.signal }); const reader = res.body?.getReader(); if (!reader) return; const decoder = new TextDecoder(); let buffer = ""; while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const chunks = buffer.split("\n\n"); buffer = chunks.pop() || ""; chunks.forEach(chunk => { const line = chunk.split("\n").find(x => x.startsWith("data:")); if (line) try { callback(JSON.parse(line.slice(5))); } catch { /* skip malformed SSE */ } }); } } catch (error) { if ((error as Error).name !== "AbortError") callback({ error: "分析连接中断" }); } })();
    return () => controller.abort();
  },
};
