// 与后端 schemas 对齐的 TypeScript 类型

// ── 简历 ──

export interface ResumeBasics {
  name: string;
  phone: string;
  email: string;
  location: string;
  title: string;
  summary: string;
  photo: string;
}

export interface ResumeEducation {
  school: string;
  major: string;
  degree: string;
  start: string;
  end: string;
  gpa: string;
  description: string;
}

export interface ResumeExperience {
  company: string;
  position: string;
  start: string;
  end: string;
  description: string;
}

export interface ResumeProject {
  name: string;
  role: string;
  start: string;
  end: string;
  description: string;
  tech_stack: string[];
}

export interface ResumeSkill {
  category: string;
  items: string[];
}

export interface ResumeData {
  basics: ResumeBasics;
  education: ResumeEducation[];
  experiences: ResumeExperience[];
  projects: ResumeProject[];
  skills: ResumeSkill[];
  template: string;
}

export interface Resume {
  id: string;
  name: string;
  data: ResumeData;
  raw_text: string;
  created_at: string;
  updated_at: string;
}

export interface ResumeListItem {
  id: string;
  name: string;
  template: string;
  created_at: string;
  updated_at: string;
  basics_name: string;
  basics_title: string;
}

export interface ResumeTemplate {
  name: string;
  description: string;
  accent: string;
}

// ── 职位库 ──

export interface Position {
  id: string;
  name: string;
  company_name: string;
  company_business_scope: string;
  job_title: string;
  job_requirements: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface PositionListItem {
  id: string;
  name: string;
  company_name: string;
  job_title: string;
  job_requirements: string;
  created_at: string;
  updated_at: string;
}

// ── 面试分析 ──

export interface MatchAnalysis {
  match_score: number;
  strong_points: string[];
  weak_points: string[];
  not_mentioned: string[];
  improvement_points: string[];
}

export interface BusinessScenario {
  scenario: string;
  inferred_problem: string;
  interview_angle: string;
}

export interface Risk {
  risk_type: string;
  description: string;
  severity: string;
  suggested_question: string;
}

export interface Question {
  direction: string;
  title: string;
  question: string;
  focus: string;
  difficulty: string;
  rationale: string;
  reference_answer: string;
  reference_hint: string;
  follow_ups: string[];
}

export interface InterviewRound {
  round_index: number;
  round_name: string;
  round_focus: string;
  questions: Question[];
}

export interface InterviewQuestions {
  rounds: InterviewRound[];
  resume_deep_dive: Question[];
  business_scenario: Question[];
  technical_professional: Question[];
  behavioral_cultural: Question[];
  pressure_adaptability: Question[];
}

export interface InterviewResult {
  company_name: string;
  job_title: string;
  match_analysis: MatchAnalysis;
  business_scenarios: BusinessScenario[];
  risks: Risk[];
  questions: InterviewQuestions;
  preparation_tips: string[];
}

export interface AnalysisResponse {
  success: boolean;
  result: InterviewResult | null;
  analysis_id: string;
  error?: string;
  model?: string;
}

// ── 模拟面试 ──

export interface InterviewTurn {
  turn_index: number;
  question: string;
  answer: string;
  evaluation: string;
  score: number;
  improvements: string[];
  evaluated: boolean;
}

export interface InterviewState {
  interview_id: string;
  status: string;
  current_question: string | null;
  current_focus: string | null;
  current_rationale: string | null;
  current_reference_answer: string | null;
  turn_index: number;
  max_turns: number;
  turns: InterviewTurn[];
  finished: boolean;
  company_name: string;
  job_title: string;
  // 多阶段字段
  is_multi_stage?: boolean;
  current_stage_index?: number;
  current_stage_type?: string | null;
  current_stage_name?: string | null;
  stages_progress?: StageProgressItem[];
  written_questions?: WrittenQuestionItem[];
}

export interface StageProgressItem {
  stage_type: string;
  stage_name: string;
  status: string;        // pending / in_progress / completed
  stage_score: number;
  turns_count: number;
}

export interface WrittenQuestionItem {
  index: number;
  title: string;
  question: string;
  focus: string;
  direction: string;
}

export interface StageConfig {
  stage_type: string;    // written / tech_1 / tech_2 / system_design / behavioral / hr / boss
  stage_name: string;
  enabled: boolean;
  question_count: number; // 笔试专用
  focus?: string;         // 本轮考察侧重
  rationale?: string;     // 安排理由
}

export interface StageRecommendResponse {
  success: boolean;
  stages?: StageConfig[];
  company_name?: string;
  job_title?: string;
  error?: string;
}

export interface StageSummary {
  stage_type: string | null;
  stage_name: string;
  stage_score: number;
  stage_summary: string;
  promotion_hint: string;
}

export interface InterviewStageReport {
  stage_type: string;
  stage_name: string;
  status: string;
  turns: InterviewTurn[];
  stage_score: number;
  stage_summary: string;
  promotion_hint: string;
}

export interface InterviewReport {
  interview_id: string;
  analysis_id: string;
  company_name: string;
  job_title: string;
  overall_score: number;
  rounds_completed: number;
  turns: InterviewTurn[];
  strengths: string[];
  weak_areas: string[];
  learning_suggestions: string[];
  summary: string;
  created_at: string;
  stages?: InterviewStageReport[];
  stages_completed?: number;
}

export interface InterviewListItem {
  id: string;
  analysis_id: string;
  status: string;
  company_name: string;
  job_title: string;
  turns: number;
  created_at: string;
  overall_score: number;
  rounds_completed: number;
  summary: string;
  is_multi_stage?: boolean;
  stages_completed?: number;
}

// ── 分析记录 ──

export interface AnalysisSummary {
  id: string;
  title: string;
  status: "pending" | "completed" | "error" | "cancelled";
  company_name: string;
  job_title: string;
  match_score: number;
  rounds_count: number;
  message_count: number;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface AnalysisDetail {
  success: boolean;
  analysis_id: string;
  title: string;
  status: "pending" | "completed" | "error" | "cancelled";
  created_at: string;
  updated_at: string;
  result: InterviewResult | null;
  error?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

// SSE 流式进度事件:后端 stream_analysis_progress 推送的 payload
export interface StreamAnalysisProgress {
  completed: { node: string; label: string }[];
  current: string | null;
}
export interface StreamAnalysisEvent {
  status?: "pending" | "completed" | "error" | "cancelled";
  progress?: StreamAnalysisProgress;
  result?: InterviewResult;
  error?: string;
}

export interface InterviewReportDetail {
  success: boolean;
  interview_id: string;
  analysis_id?: string;
  status: string;
  company_name: string;
  job_title: string;
  turns: InterviewTurn[];
  report: InterviewReport | null;
}

// ── 其他 ──

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts?: number;
}

export interface ChatResponse {
  answer: string;
  analysis_id: string;
  result?: InterviewResult | null;
  error?: string;
}

export interface ModelInfo {
  provider: string;
  model: string;
  api_key_configured: boolean;
  base_url: string;
}

export interface ModelConfigRequest {
  provider?: string;
  model?: string;
  api_key?: string;
  base_url?: string;
}

export interface ModelTestRequest {
  model: string;
  api_key: string;
  base_url: string;
}

export interface ModelTestResponse {
  success: boolean;
  latency_ms: number;
  reply: string;
  error: string;
}

export interface AnalysisSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  metadata: Record<string, unknown>;
}

export interface ExportResponse {
  success: boolean;
  filename?: string;
  error?: string;
}

export interface ReportFile {
  name: string;
  size: number;
}
