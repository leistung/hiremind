/**
 * lib/types.ts —— 前端 TypeScript 类型定义
 *
 * 所有类型与后端 FastAPI 的 Pydantic schema(app/server/schemas.py)对齐,
 * 前后端共用同一套字段命名(下划线风格),保证 API 返回数据可直接类型化。
 * 按业务域分区:简历 / 职位库 / 面试分析 / 模拟面试 / 分析记录 / 其他(对话、模型、导出)。
 */

// ═══════════════════════════════ 简历 ═══════════════════════════════

/** 简历基本信息块(对应后端 ResumeBasics)。 */
export interface ResumeBasics {
  name: string; // 姓名
  phone: string; // 联系电话
  email: string; // 邮箱
  location: string; // 所在地
  title: string; // 求职意向 / 职位头衔
  summary: string; // 个人简介
  photo: string; // 头像(后端存储的相对路径或完整 URL)
}

/** 教育经历单条记录(对应后端 ResumeEducation)。 */
export interface ResumeEducation {
  school: string; // 学校名称
  major: string; // 专业
  degree: string; // 学历(本科/硕士/博士等)
  start: string; // 开始时间(文本形式,如 "2020.09")
  end: string; // 结束时间(文本形式,如 "2024.06";在读可填 "至今")
  gpa: string; // 绩点(可空)
  description: string; // 在校经历描述
}

/** 工作经历单条记录(对应后端 ResumeExperience)。 */
export interface ResumeExperience {
  company: string; // 公司名称
  position: string; // 职位
  start: string; // 开始时间
  end: string; // 结束时间
  description: string; // 工作内容与成果描述
}

/** 项目经历单条记录(对应后端 ResumeProject)。 */
export interface ResumeProject {
  name: string; // 项目名称
  role: string; // 担任角色
  start: string; // 开始时间
  end: string; // 结束时间
  description: string; // 项目描述与个人贡献
  tech_stack: string[]; // 用到的技术栈列表
}

/** 技能分类单条记录(对应后端 ResumeSkill)。 */
export interface ResumeSkill {
  category: string; // 技能分类名(如 "前端开发")
  items: string[]; // 该分类下的具体技能列表
}

/** 完整简历数据结构(三套模板共用同一份数据模型)。 */
export interface ResumeData {
  basics: ResumeBasics; // 基本信息
  education: ResumeEducation[]; // 教育经历列表
  experiences: ResumeExperience[]; // 工作经历列表
  projects: ResumeProject[]; // 项目经历列表
  skills: ResumeSkill[]; // 技能分类列表
  template: string; // 模板标识:"classic" | "modern" | "minimal"
}

/** 简历完整对象(详情接口返回,含原始文本与时间戳)。 */
export interface Resume {
  id: string; // 简历唯一 ID
  name: string; // 简历名称(文件名/自定义名)
  data: ResumeData; // 结构化简历数据
  raw_text: string; // 上传解析出的原始文本(便于溯源)
  created_at: string; // 创建时间(ISO 字符串)
  updated_at: string; // 最近更新时间(ISO 字符串)
}

/** 简历列表项(列表接口返回的轻量摘要,不含完整 data)。 */
export interface ResumeListItem {
  id: string; // 简历唯一 ID
  name: string; // 简历名称
  template: string; // 使用的模板
  created_at: string; // 创建时间
  updated_at: string; // 最近更新时间
  basics_name: string; // 冗余字段:简历中填写的姓名(用于列表展示)
  basics_title: string; // 冗余字段:求职意向(用于列表展示)
}

/** 简历模板元信息(三套模板的描述与强调色)。 */
export interface ResumeTemplate {
  name: string; // 模板名称
  description: string; // 模板风格描述
  accent: string; // 模板强调色(如 "orange")
}

// ═══════════════════════════════ 职位库 ═══════════════════════════════

/** 职位完整对象(对应后端 Position,支持匿名 JD 场景)。 */
export interface Position {
  id: string; // 职位唯一 ID
  name: string; // 职位记录名称(自定义标签)
  company_name: string; // 公司名称(可空,适配匿名 JD)
  company_business_scope: string; // 公司业务范围(用于分析时的业务场景推演)
  job_title: string; // 职位名称(如 "前端开发工程师")
  job_requirements: string; // JD 正文(职位要求)
  notes: string; // 备注(补充说明)
  created_at: string; // 创建时间
  updated_at: string; // 最近更新时间
}

/** 职位列表项(列表接口返回的轻量摘要)。 */
export interface PositionListItem {
  id: string; // 职位唯一 ID
  name: string; // 职位记录名称
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  job_requirements: string; // JD 正文摘要
  created_at: string; // 创建时间
  updated_at: string; // 最近更新时间
}

// ═══════════════════════════════ 面试分析 ═══════════════════════════════

/** 匹配度分析结果(分析图"匹配度分析"节点的产出)。 */
export interface MatchAnalysis {
  match_score: number; // 匹配度评分(0-100)
  strong_points: string[]; // 强项列表
  weak_points: string[]; // 弱项列表
  not_mentioned: string[]; // 简历未提及但 JD 需要的技能
  improvement_points: string[]; // 改进建议列表
}

/** 业务场景推演单条(分析图"业务场景推演"节点的产出)。 */
export interface BusinessScenario {
  scenario: string; // 业务场景描述
  inferred_problem: string; // 从公司业务范围推测出的核心问题
  interview_angle: string; // 面试中可能的切入角度
}

/** 履历风险单条(分析图"履历风险识别"节点的产出)。 */
export interface Risk {
  risk_type: string; // 风险类型
  description: string; // 风险描述
  severity: string; // 严重度:"high" | "mid" | "low"
  suggested_question: string; // 面试官可能的追问建议
}

/** 面试题单条(分析图"生成面试题"节点的产出)。 */
export interface Question {
  direction: string; // 出题方向(如 "技术深度")
  title: string; // 题目标题
  question: string; // 题目正文
  focus: string; // 考察点
  difficulty: string; // 难度(如 "中"/"高")
  rationale: string; // 出题分析(为什么出这道题)
  reference_answer: string; // 参考答案
  reference_hint: string; // 回答提示
  follow_ups: string[]; // 追问列表
}

/** 面试轮次(按轮组织题目)。 */
export interface InterviewRound {
  round_index: number; // 轮次序号(从 1 开始)
  round_name: string; // 轮次名称(如 "第一轮:技术面")
  round_focus: string; // 本轮考察侧重
  questions: Question[]; // 本轮题目列表
}

/** 面试题集合(按考察维度分类组织)。 */
export interface InterviewQuestions {
  rounds: InterviewRound[]; // 按轮次组织的题目
  resume_deep_dive: Question[]; // 简历深挖题
  business_scenario: Question[]; // 业务场景题
  technical_professional: Question[]; // 技术专业题
  behavioral_cultural: Question[]; // 行为/文化题
  pressure_adaptability: Question[]; // 压力与应变题
}

/** 一次面试分析产出的完整结果报告。 */
export interface InterviewResult {
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  match_analysis: MatchAnalysis; // 匹配度分析
  business_scenarios: BusinessScenario[]; // 业务场景推演
  risks: Risk[]; // 履历风险识别
  questions: InterviewQuestions; // 面试题集合
  preparation_tips: string[]; // 备考建议
}

/** 发起分析接口(/analysis/run)的响应。 */
export interface AnalysisResponse {
  success: boolean; // 是否成功发起
  result: InterviewResult | null; // 同步返回的结果(异步模式下通常为 null)
  analysis_id: string; // 分析任务 ID(用于后续查询/订阅进度)
  error?: string; // 错误信息
  model?: string; // 使用的模型名
}

// ═══════════════════════════════ 模拟面试 ═══════════════════════════════

/** 面试中单轮问答记录。 */
export interface InterviewTurn {
  turn_index: number; // 轮次序号(从 1 开始)
  question: string; // 面试官提问
  answer: string; // 用户(候选人)回答
  evaluation: string; // AI 评价
  score: number; // 本轮评分(0-10)
  improvements: string[]; // 改进点列表
  evaluated: boolean; // 是否已评价(笔试批量模式下用于标记状态)
}

/** 模拟面试进行中的完整状态(前端据此渲染整个面试流程)。 */
export interface InterviewState {
  interview_id: string; // 面试唯一 ID
  status: string; // 状态:started | answering | completed | abandoned 等
  current_question: string | null; // 当前提问(逐题模式下非空)
  current_focus: string | null; // 当前题目考察点
  current_rationale: string | null; // 当前题目出题分析
  current_reference_answer: string | null; // 当前题目参考答案
  turn_index: number; // 已进行的轮次数
  max_turns: number; // 最大轮次上限
  turns: InterviewTurn[]; // 已完成的问答列表
  finished: boolean; // 是否已结束
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  // ── 多阶段模式字段(LLM 智能规划阶段方案后启用) ──
  is_multi_stage?: boolean; // 是否启用多阶段模式
  current_stage_index?: number; // 当前阶段下标
  current_stage_type?: string | null; // 当前阶段类型(written/tech_1/...)
  current_stage_name?: string | null; // 当前阶段名称
  stages_progress?: StageProgressItem[]; // 各阶段进度列表
  written_questions?: WrittenQuestionItem[]; // 笔试题目列表
}

/** 多阶段模式下单个阶段的进度项。 */
export interface StageProgressItem {
  stage_type: string; // 阶段类型(written/tech_1/tech_2/system_design/behavioral/hr/boss)
  stage_name: string; // 阶段展示名
  status: string; // 状态:pending(未开始) / in_progress(进行中) / completed(已完成)
  stage_score: number; // 该阶段得分(0-100,未完成时为 0)
  turns_count: number; // 该阶段已完成的轮次数
}

/** 笔试阶段的单道题目。 */
export interface WrittenQuestionItem {
  index: number; // 题号(从 1 开始)
  title: string; // 题目标题
  question: string; // 题目正文
  focus: string; // 考察点
  direction: string; // 出题方向
}

/** 单个阶段的配置(LLM 规划面试方案时生成)。 */
export interface StageConfig {
  stage_type: string; // 阶段类型(written / tech_1 / tech_2 / system_design / behavioral / hr / boss)
  stage_name: string; // 阶段展示名
  enabled: boolean; // 是否启用该阶段
  question_count: number; // 题数(笔试阶段专用)
  focus?: string; // 本轮考察侧重(可空)
  rationale?: string; // 安排理由(可空)
}

/** 智能规划阶段方案接口(/interview/stages/recommend)的响应。 */
export interface StageRecommendResponse {
  success: boolean; // 是否成功
  stages?: StageConfig[]; // 规划出的阶段配置列表
  company_name?: string; // 公司名称(透传)
  job_title?: string; // 职位名称(透传)
  error?: string; // 错误信息
}

/** 单个阶段完成后的总结(软晋级提示用)。 */
export interface StageSummary {
  stage_type: string | null; // 阶段类型
  stage_name: string; // 阶段名称
  stage_score: number; // 阶段得分(0-100)
  stage_summary: string; // 阶段总结评语
  promotion_hint: string; // 晋级提示语
}

/** 最终报告中的单个阶段成绩块。 */
export interface InterviewStageReport {
  stage_type: string; // 阶段类型
  stage_name: string; // 阶段名称
  status: string; // 阶段状态
  turns: InterviewTurn[]; // 该阶段的问答记录
  stage_score: number; // 阶段得分
  stage_summary: string; // 阶段总结
  promotion_hint: string; // 晋级提示
}

/** 模拟面试最终报告(面试结束后生成)。 */
export interface InterviewReport {
  interview_id: string; // 面试唯一 ID
  analysis_id: string; // 关联的分析 ID
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  overall_score: number; // 综合评分(0-100)
  rounds_completed: number; // 已完成轮次
  turns: InterviewTurn[]; // 全部问答记录
  strengths: string[]; // 优势总结
  weak_areas: string[]; // 薄弱环节
  learning_suggestions: string[]; // 学习建议
  summary: string; // 总体评价
  created_at: string; // 报告生成时间
  stages?: InterviewStageReport[]; // 分阶段成绩(多阶段模式)
  stages_completed?: number; // 已完成阶段数(多阶段模式)
}

/** 面试列表项(历史记录页展示用)。 */
export interface InterviewListItem {
  id: string; // 面试唯一 ID
  analysis_id: string; // 关联的分析 ID
  status: string; // 面试状态
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  turns: number; // 已完成的问答轮次
  created_at: string; // 创建时间
  overall_score: number; // 综合评分(未结束为 0)
  rounds_completed: number; // 已完成轮次
  summary: string; // 总结摘要
  is_multi_stage?: boolean; // 是否多阶段模式
  stages_completed?: number; // 已完成阶段数
}

// ═══════════════════════════════ 分析记录 ═══════════════════════════════

/** 面试分析记录摘要(历史记录页"分析"Tab 列表用)。
 *  注意:下方另有同名 interface,TypeScript 会自动做声明合并,两处字段并集生效。 */
export interface AnalysisSummary {
  id: string; // 分析记录唯一 ID
  title: string; // 记录标题(公司-职位)
  status: "pending" | "completed" | "error" | "cancelled"; // 分析状态
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  match_score: number; // 匹配度评分
  rounds_count: number; // 生成的面试轮次数
  message_count: number; // 消息数(Ask 对话计数)
  created_at: string; // 创建时间
  updated_at: string; // 最近更新时间
  metadata: Record<string, unknown>; // 扩展元数据(任意键值)
}

/** 节点 IO 记录(分析图每个节点的产出,供 Ask 助手 read_node_io 读取)。 */
export interface NodeIORecord {
  node: string; // 节点标识(如 "parse_jd")
  label: string; // 节点展示名(如 "解析 JD")
  output: Record<string, unknown>; // 节点输出内容
  ts: string; // 节点完成时间戳
}

/** 分析详情(历史记录页详情接口返回)。 */
export interface AnalysisDetail {
  success: boolean; // 是否成功
  analysis_id: string; // 分析 ID
  title: string; // 记录标题
  status: "pending" | "completed" | "error" | "cancelled"; // 分析状态
  created_at: string; // 创建时间
  updated_at: string; // 最近更新时间
  result: InterviewResult | null; // 分析结果(未完成时为 null)
  error?: string; // 错误信息
  model?: string; // 使用的模型名
  metadata?: Record<string, unknown>; // 扩展元数据
  node_io?: NodeIORecord[]; // 各节点 IO 记录列表
}

/** SSE 流式进度事件中的 progress 载荷:已完成节点 + 当前节点。 */
export interface StreamAnalysisProgress {
  completed: { node: string; label: string }[]; // 已完成的节点列表
  current: string | null; // 当前正在执行的节点(无则为 null)
}

/** SSE 流式分析进度事件(后端 /analysis/stream/{id} 推送的 payload)。 */
export interface StreamAnalysisEvent {
  status?: "pending" | "completed" | "error" | "cancelled"; // 整体状态
  progress?: StreamAnalysisProgress; // 进度信息(进行中时携带)
  result?: InterviewResult; // 最终结果(完成时携带)
  error?: string; // 错误信息(出错时携带)
  node_io?: NodeIORecord[]; // 节点 IO(完成时携带)
}

/** 面试报告详情(历史记录页"模拟面试"Tab 详情接口返回)。 */
export interface InterviewReportDetail {
  success: boolean; // 是否成功
  interview_id: string; // 面试 ID
  analysis_id?: string; // 关联分析 ID
  status: string; // 面试状态
  company_name: string; // 公司名称
  job_title: string; // 职位名称
  turns: InterviewTurn[]; // 全部问答记录
  report: InterviewReport | null; // 最终报告(未结束为 null)
}

// ═══════════════════════════════ 其他 ═══════════════════════════════

/** Ask 助手对话消息。 */
export interface ChatMessage {
  role: "user" | "assistant"; // 消息角色:用户或助手
  content: string; // 消息正文
  ts?: number; // 可选时间戳
}

/** Ask 助手对话响应(非流式场景)。 */
export interface ChatResponse {
  answer: string; // 助手回答
  analysis_id: string; // 关联分析 ID(如适用)
  result?: InterviewResult | null; // 分析结果(如适用)
  error?: string; // 错误信息
}

/** 当前模型配置信息(侧边栏 ModelBadge 展示用)。 */
export interface ModelInfo {
  provider: string; // 供应商(如 "bailian"/"openai")
  model: string; // 模型名(如 "qwen3.7-plus")
  api_key_configured: boolean; // 是否已配置 API Key
  base_url: string; // 接口 Base URL
}

/** 更新模型配置的请求体。 */
export interface ModelConfigRequest {
  provider?: string; // 供应商
  model?: string; // 模型名
  api_key?: string; // API Key
  base_url?: string; // Base URL
}

/** 连接测试请求体。 */
export interface ModelTestRequest {
  model: string; // 要测试的模型名
  api_key: string; // 要测试的 API Key
  base_url: string; // 要测试的 Base URL
}

/** 连接测试响应。 */
export interface ModelTestResponse {
  success: boolean; // 是否连通
  latency_ms: number; // 延迟(毫秒)
  reply: string; // 模型回复(测试消息的应答)
  error: string; // 错误信息(失败时)
}

/** AnalysisSummary 的第二次声明:与上方同名 interface 合并,
 *  补充 history 页所需的字段(created_at/updated_at 已在上方声明,此处为历史遗留重复)。
 *  注:此处的重复声明是历史代码,TS 声明合并后不会报错,但新增字段请优先加到上方定义。 */
export interface AnalysisSummary {
  id: string; // 分析记录唯一 ID(重复声明,与上方一致)
  title: string; // 记录标题(重复声明)
  created_at: string; // 创建时间(重复声明)
  updated_at: string; // 最近更新时间(重复声明)
  message_count: number; // 消息数(重复声明)
  metadata: Record<string, unknown>; // 扩展元数据(重复声明)
}

/** 导出操作响应。 */
export interface ExportResponse {
  success: boolean; // 是否成功
  filename?: string; // 导出文件名
  error?: string; // 错误信息
}

/** 已导出报告文件的元信息。 */
export interface ReportFile {
  name: string; // 文件名
  size: number; // 文件大小(字节)
}
