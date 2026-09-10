/**
 * lib/api.ts —— 后端 API 客户端
 *
 * 直连 FastAPI 后端(绕过 Next.js rewrites 代理的 30 秒超时限制,
 * 因为 LLM 分析等长耗时请求可能持续数分钟)。
 * 优先使用 NEXT_PUBLIC_API_BASE 环境变量,默认直连本地 8000 端口。
 *
 * 统一封装了 GET / POST / PUT / DELETE 四类请求方法,
 * 并对所有接口按业务域分组暴露为 api 对象的成员。
 */

// 引入全部后端类型,保证每个接口的返回数据有完整类型约束
import type {
  AnalysisDetail, // 分析详情
  AnalysisResponse, // 发起分析的响应
  InterviewListItem, // 面试列表项
  InterviewReport, // 面试最终报告
  InterviewReportDetail, // 面试报告详情
  InterviewState, // 面试进行中状态
  InterviewTurn, // 单轮问答
  ModelConfigRequest, // 模型配置请求体
  ModelInfo, // 模型信息
  ModelTestRequest, // 连接测试请求体
  ModelTestResponse, // 连接测试响应
  Position, // 职位详情
  PositionListItem, // 职位列表项
  ReportFile, // 导出报告文件元信息
  Resume, // 简历详情
  ResumeData, // 简历数据
  ResumeListItem, // 简历列表项
  ResumeTemplate, // 简历模板
  AnalysisSummary, // 分析记录摘要
  ExportResponse, // 导出响应
  StageConfig, // 面试阶段配置
  StageRecommendResponse, // 阶段规划响应
  StageSummary, // 阶段总结
  StreamAnalysisEvent, // SSE 分析进度事件
} from "./types";

/** API 基础地址:优先取构建时注入的 NEXT_PUBLIC_API_BASE,否则直连本地 8000。 */
const BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000/api";

/**
 * 通用 POST 请求(带可选超时)。
 * 长耗时请求(如 LLM 分析)需要显式传 timeoutMs,
 * 否则浏览器/代理会在约 2 分钟时断开连接。
 * @param url - 相对路径(拼接在 BASE 之后)
 * @param body - 请求体,自动 JSON 序列化
 * @param timeoutMs - 可选超时毫秒数;传入则用 AbortController 控制中断
 * @returns 后端返回的 JSON,按泛型 T 解析
 */
async function postJson<T>(url: string, body: unknown, timeoutMs?: number): Promise<T> {
  // 构造基础请求配置:POST + JSON 请求头 + 序列化后的请求体
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (timeoutMs) {
    // 带超时分支:用 AbortController 在超时后主动中断请求
    const controller = new AbortController(); // 创建中断控制器
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs); // 到点触发 abort
    try {
      // 携带 signal 发起请求,使其可被 controller.abort() 中断
      const res = await fetch(`${BASE}${url}`, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`); // 非 2xx 抛错
      return res.json() as Promise<T>; // 解析 JSON 并断言为泛型 T
    } finally {
      clearTimeout(timeoutId); // 请求结束(无论成败)都要清除定时器,防止泄漏
    }
  }
  // 无超时分支:普通 POST
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`); // 非 2xx 抛错
  }
  return res.json() as Promise<T>; // 解析 JSON 并断言为泛型 T
}

/**
 * 通用 GET 请求。
 * @param url - 相对路径(拼接在 BASE 之后)
 * @returns 后端返回的 JSON,按泛型 T 解析
 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`); // 发起 GET
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`); // 非 2xx 抛错
  }
  return res.json() as Promise<T>; // 解析 JSON 并断言为泛型 T
}

/**
 * 通用 PUT 请求(用于资源整体更新,如简历/职位保存)。
 * @param url - 相对路径(拼接在 BASE 之后)
 * @param body - 请求体,自动 JSON 序列化
 * @returns 后端返回的 JSON,按泛型 T 解析
 */
async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method: "PUT", // PUT 语义:整体更新
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), // 序列化请求体
  });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`); // 非 2xx 抛错
  }
  return res.json() as Promise<T>; // 解析 JSON 并断言为泛型 T
}

/**
 * 通用 DELETE 请求(用于资源删除)。
 * @param url - 相对路径(拼接在 BASE 之后)
 * @returns 后端返回的 JSON,按泛型 T 解析
 */
async function del<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`, { method: "DELETE" }); // 发起 DELETE
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`); // 非 2xx 抛错
  }
  return res.json() as Promise<T>; // 解析 JSON 并断言为泛型 T
}

/**
 * api —— 所有后端接口的聚合对象,按业务域分组。
 * 每个成员均返回 Promise,页面/组件直接 await 使用。
 */
export const api = {
  // ─────────────────────────── 健康检查 ───────────────────────────

  /** 查询后端健康状态(侧边栏绿点/红点指示用)。 */
  health: () =>
    getJson<{ status: string; version: string; workspace: string }>("/health"),

  // ─────────────────────────── 模型配置 ───────────────────────────

  /** 获取当前模型配置信息(供应商/模型名/是否配置 Key)。 */
  getModelInfo: () => getJson<ModelInfo>("/models/info"),

  /** 获取阿里云百炼预设的可用模型列表(设置页 datalist 自动补全用)。 */
  getBailianModels: () => getJson<{ models: string[] }>("/models/bailian"),

  /** 更新模型配置并持久化到 .hiremind/model_config.json。 */
  updateModelConfig: (req: ModelConfigRequest) =>
    postJson<{ success: boolean; model: string }>("/models/config", req),

  /** 测试模型连接(发一条 ping 消息,返回延迟与回复)。 */
  testModelConnection: (req: ModelTestRequest) =>
    postJson<ModelTestResponse>("/models/test", req),

  // ─────────────────────────── 文档解析 ───────────────────────────

  /**
   * 通用文档解析(提取纯文本)。
   * 通过 FormData 上传文件,走 /documents/parse 接口。
   * @param file - 要解析的文件(PDF/Word/TXT/Markdown)
   * @returns 解析结果,含提取出的文本或错误信息
   */
  parseDocument: async (file: File) => {
    const fd = new FormData(); // 构造 FormData 用于文件上传
    fd.append("file", file); // 以 "file" 字段追加文件
    const res = await fetch(`${BASE}/documents/parse`, {
      method: "POST",
      body: fd, // 浏览器自动设置 multipart 边界
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // 非 2xx 抛错
    return res.json() as Promise<{
      success: boolean; // 是否成功
      text?: string; // 提取出的纯文本
      error?: string; // 错误信息
      filename?: string; // 原文件名
    }>;
  },

  // ─────────────────────────── 简历 ───────────────────────────

  /** 获取三套简历模板的元信息(名称/描述/强调色)。 */
  listResumeTemplates: () =>
    getJson<{ templates: Record<string, ResumeTemplate> }>("/resumes/templates"),

  /** 获取简历列表(轻量摘要)。 */
  listResumes: () =>
    getJson<{ resumes: ResumeListItem[] }>("/resumes"),

  /** 获取单个简历的完整详情(含结构化数据与原始文本)。 */
  getResume: (id: string) =>
    getJson<{ success: boolean; resume: Resume }>(`/resumes/${id}`),

  /** 创建新简历(支持空模板创建或带初始数据)。 */
  createResume: (body: {
    name?: string; // 简历名称
    data?: Partial<ResumeData>; // 结构化数据(可部分填充)
    raw_text?: string; // 原始文本
    template?: string; // 模板标识
  }) => postJson<{ success: boolean; resume: Resume }>("/resumes", body),

  /** 更新简历(整体更新,传入修改后的字段)。 */
  updateResume: (
    id: string, // 简历 ID
    body: {
      name?: string; // 简历名称
      data?: Partial<ResumeData>; // 结构化数据
      raw_text?: string; // 原始文本
      template?: string; // 模板标识
    },
  ) => putJson<{ success: boolean; resume: Resume }>(`/resumes/${id}`, body),

  /** 删除简历。 */
  deleteResume: (id: string) =>
    del<{ success: boolean }>(`/resumes/${id}`),

  /** 将纯文本交给 LLM 结构化为 ResumeData(粘贴文本新建简历场景)。 */
  parseResumeText: (text: string) =>
    postJson<{ success: boolean; data?: ResumeData; error?: string }>(
      "/resumes/parse-text",
      { text }, // 请求体:原始文本
    ),

  /**
   * 上传文件并让 LLM 解析为结构化简历数据。
   * LLM 结构化解析较慢(可能 1-10 分钟),故设置 10 分钟超时。
   * @param file - 简历文件(PDF/Word/TXT/Markdown)
   * @returns 解析结果对象:成功时含 text/data,失败时含 error(本函数不会抛出异常)
   */
  uploadParseResume: async (file: File) => {
    const fd = new FormData(); // 构造 FormData 用于文件上传
    fd.append("file", file); // 以 "file" 字段追加文件
    // 长耗时解析:用 AbortController 实现 10 分钟超时保护
    const controller = new AbortController(); // 创建中断控制器
    const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 分钟后自动中断
    try {
      const res = await fetch(`${BASE}/resumes/upload-parse`, {
        method: "POST",
        body: fd,
        signal: controller.signal, // 绑定中断信号
      });
      // 非 2xx:尝试从响应体里取出后端返回的错误详情
      if (!res.ok) {
        let detail = "";
        try {
          const errBody = await res.json();
          detail = errBody?.detail ?? errBody?.error ?? "";
        } catch {
          // 响应体不是 JSON 时忽略,用状态码兜底
        }
        return {
          success: false as const,
          error: `服务端返回 ${res.status}${detail ? `：${detail}` : ""}`,
        };
      }
      return res.json() as Promise<{
        success: boolean; // 是否成功
        text?: string; // 提取出的原始文本
        data?: ResumeData; // 结构化数据
        error?: string; // 错误信息
        filename?: string; // 原文件名
      }>;
    } catch (err) {
      // 超时中断 → 明确提示,而不是让 UI 卡死
      if ((err as Error)?.name === "AbortError") {
        return {
          success: false as const,
          error: "解析超时(超过 10 分钟),请稍后重试,或换一份更小的简历",
        };
      }
      // 网络错误 / 连接断开 / 响应格式异常
      return {
        success: false as const,
        error: `网络错误:${err instanceof Error ? err.message : "请求失败"}`,
      };
    } finally {
      clearTimeout(timeoutId); // 无论成败都清除定时器
    }
  },

  /** 导出简历为 Word 或 PDF(后端用模板渲染后返回文件名)。 */
  exportResume: (id: string, format: "word" | "pdf", template?: string) =>
    postJson<ExportResponse>(`/resumes/${id}/export`, { format, template }),

  /** 上传简历头像照片。 */
  uploadResumePhoto: async (id: string, file: File) => {
    const fd = new FormData(); // 构造 FormData
    fd.append("file", file); // 以 "file" 字段追加图片文件
    const res = await fetch(`${BASE}/resumes/${id}/photo`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // 非 2xx 抛错
    return res.json() as Promise<{
      success: boolean; // 是否成功
      photo?: string; // 头像的存储路径/URL
      error?: string; // 错误信息
    }>;
  },

  // ─────────────────────────── 职位库 ───────────────────────────

  /** 获取职位列表(轻量摘要,含搜索所需字段)。 */
  listPositions: () =>
    getJson<{ positions: PositionListItem[] }>("/positions"),

  /** 获取单个职位完整详情。 */
  getPosition: (id: string) =>
    getJson<{ success: boolean; position: Position }>(`/positions/${id}`),

  /** 创建职位(公司名/职位名可空,适配匿名 JD)。 */
  createPosition: (body: {
    name?: string; // 职位记录名称
    company_name?: string; // 公司名称
    company_business_scope?: string; // 公司业务范围
    job_title?: string; // 职位名称
    job_requirements?: string; // JD 正文
    notes?: string; // 备注
  }) =>
    postJson<{ success: boolean; position: Position }>("/positions", body),

  /** 更新职位。 */
  updatePosition: (id: string, body: {
    name?: string; // 职位记录名称
    company_name?: string; // 公司名称
    company_business_scope?: string; // 公司业务范围
    job_title?: string; // 职位名称
    job_requirements?: string; // JD 正文
    notes?: string; // 备注
  }) =>
    putJson<{ success: boolean; position: Position }>(`/positions/${id}`, body),

  /** 删除职位。 */
  deletePosition: (id: string) => del<{ success: boolean }>(`/positions/${id}`),

  // ─────────────────────────── 面试分析 ───────────────────────────

  /**
   * 发起一次面试分析(异步:立即返回 analysis_id,结果后台生成)。
   * @param body - 分析输入:职位信息 + 简历内容(文本或引用 ID)
   */
  runAnalysis: (body: {
    company_name: string; // 公司名称
    company_business_scope: string; // 公司业务范围
    job_title: string; // 职位名称
    job_requirements: string; // JD 正文
    resume: string; // 简历内容(结构化文本或原始文本)
    resume_id?: string; // 关联简历 ID(可选)
    resume_name?: string; // 关联简历名称(可选)
    position_id?: string; // 关联职位 ID(可选)
    position_name?: string; // 关联职位名称(可选)
  }) => postJson<AnalysisResponse>("/analysis/run", body),

  /** 获取面试报告(历史记录页展示用)。 */
  getInterviewReport: (interview_id: string) =>
    getJson<InterviewReportDetail>(`/interview/${interview_id}/report`),

  // ─────────────────────────── 分析记录管理 ───────────────────────────

  /** 获取全部分析记录摘要(历史记录页"分析"Tab 列表)。 */
  listAnalyses: () =>
    getJson<{ analyses: AnalysisSummary[] }>("/analyses"),

  /** 获取单条分析记录详情(含结果与节点 IO)。 */
  getAnalysis: (analysis_id: string) =>
    getJson<AnalysisDetail>(`/analyses/${analysis_id}`),

  /** 删除分析记录。 */
  deleteAnalysis: (analysis_id: string) =>
    del<{ success: boolean }>(`/analyses/${analysis_id}`),

  /** 取消正在进行的分析(保留表单输入便于重试)。 */
  cancelAnalysis: (analysis_id: string) =>
    postJson<{ success: boolean; status: string }>(`/analyses/${analysis_id}/cancel`, {}),

  /**
   * SSE 流式接收分析进度。
   * 建立到 /analysis/stream/{id} 的 EventSource 风格长连接,
   * 手动解析 SSE 协议(data: 行,双换行分隔)。
   * @param analysis_id - 分析任务 ID
   * @param onEvent - 每次收到事件时的回调(payload 已 JSON 解析)
   * @returns 一个 abort 函数,调用即断开连接(用于组件卸载/停止分析)
   */
  streamAnalysis: (
    analysis_id: string,
    onEvent: (payload: StreamAnalysisEvent) => void,
  ): (() => void) => {
    const controller = new AbortController(); // 中断控制器,供返回的 abort 函数使用
    const url = `${BASE}/analysis/stream/${analysis_id}`; // SSE 端点完整 URL

    // 立即启动异步读取循环(不阻塞调用方)
    (async () => {
      try {
        // 发起流式请求,声明接受 text/event-stream
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal, // 绑定中断信号
          headers: { Accept: "text/event-stream" }, // 声明 SSE 内容类型
        });
        if (!res.ok || !res.body) {
          onEvent({ error: `HTTP ${res.status}` }); // 非 2xx 或无 body 时报错回调
          return;
        }
        const reader = res.body.getReader(); // 获取流读取器
        const decoder = new TextDecoder("utf-8"); // UTF-8 解码器(处理多字节字符)
        let buffer = ""; // 累积缓冲区(SSE 事件可能被 TCP 分包)
        while (true) {
          const { value, done } = await reader.read(); // 读取一块二进制数据
          if (done) break; // 流结束
          buffer += decoder.decode(value, { stream: true }); // 解码并追加到缓冲区
          // SSE 事件以双换行(\n\n)分隔,逐条取出处理
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx); // 取出当前完整事件块
            buffer = buffer.slice(idx + 2); // 消费掉已处理部分
            // 解析事件块中的 data: 行(忽略注释行等)
            const lines = raw.split("\n");
            const dataLine = lines.find((l) => l.startsWith("data:"));
            if (!dataLine) continue; // 无 data 行则跳过
            const jsonStr = dataLine.slice(5).trim(); // 去掉 "data:" 前缀并去空白
            if (!jsonStr) continue; // 空载荷跳过
            try {
              const payload = JSON.parse(jsonStr) as StreamAnalysisEvent; // 反序列化
              onEvent(payload); // 回调给调用方
            } catch {
              // 忽略单条解析错误,继续处理后续事件
            }
          }
        }
      } catch (e) {
        // 非主动中断的错误才回调;AbortError 是正常停止,不上报
        if ((e as Error).name !== "AbortError") {
          onEvent({ error: (e as Error).message || "连接失败" });
        }
      }
    })();

    // 返回 abort 函数:调用即中断 fetch 流
    return () => controller.abort();
  },

  // ─────────────────────────── 模拟面试 ───────────────────────────

  /**
   * 智能规划面试阶段方案。
   * LLM 根据岗位/公司/期望轮次生成阶段配置(written/tech_1/tech_2/...等)。
   * @param analysis_id - 关联的分析 ID(提供岗位与简历上下文)
   * @param expected_rounds - 期望的面试轮次数
   */
  recommendStages: (analysis_id: string, expected_rounds: number) =>
    postJson<StageRecommendResponse>("/interview/stages/recommend", {
      analysis_id, // 分析 ID
      expected_rounds, // 期望轮次
    }),

  /**
   * 启动模拟面试。
   * @param analysis_id - 关联的分析 ID
   * @param max_turns - 最大轮次上限,默认 8
   * @param stages - 多阶段模式的阶段配置列表(可选;不传则走旧式单轨流程)
   */
  startInterview: (
    analysis_id: string,
    max_turns = 8,
    stages?: StageConfig[],
  ) =>
    postJson<{
      success: boolean; // 是否成功
      state?: InterviewState; // 面试初始状态
      first_question?: string; // 第一道题(非笔试阶段)
      error?: string; // 错误信息
    }>("/interview/start", { analysis_id, max_turns, stages: stages || [] }),

  /** 提交当前题目的回答(逐题模式),返回本轮评价与更新后的状态。 */
  submitInterviewAnswer: (interview_id: string, answer: string) =>
    postJson<{
      success: boolean; // 是否成功
      turn?: InterviewTurn; // 本轮问答记录(含评分/评价)
      state?: InterviewState; // 更新后的面试状态
      error?: string; // 错误信息
    }>(`/interview/${interview_id}/answer`, { answer }),

  /** 请求下一道题(逐题模式);面试可能随之结束或进入阶段总结。 */
  nextInterviewQuestion: (interview_id: string) =>
    postJson<{
      success: boolean; // 是否成功
      finished?: boolean; // 是否已全部结束
      next_question?: string; // 下一道题
      report?: InterviewReport; // 结束时的最终报告
      stage_completed?: boolean; // 当前阶段是否完成(多阶段模式)
      stage_summary?: StageSummary; // 阶段总结(阶段完成时)
      state?: InterviewState; // 更新后的面试状态
      error?: string; // 错误信息
    }>(`/interview/${interview_id}/next`, {}),

  /** 笔试批量提交:一次提交全部笔试题答案,返回批量评价与阶段得分。 */
  submitWrittenAnswers: (interview_id: string, answers: Record<string, string>) =>
    postJson<{
      success: boolean; // 是否成功
      turns?: InterviewTurn[]; // 批量生成的问答记录
      stage_score?: number; // 笔试阶段得分
      stage_summary?: string; // 阶段总结
      promotion_hint?: string; // 晋级提示
      state?: InterviewState; // 更新后的面试状态
      error?: string; // 错误信息
    }>(`/interview/${interview_id}/written/submit`, { answers }),

  /** 进入下一阶段(多阶段模式):返回下一阶段的首题或笔试题目。 */
  advanceStage: (interview_id: string) =>
    postJson<{
      success: boolean; // 是否成功
      finished?: boolean; // 是否已全部结束
      next_question?: string; // 下一阶段首题(逐题型阶段)
      written_ready?: boolean; // 下一阶段是否为笔试(批量型阶段)
      report?: InterviewReport; // 结束时的最终报告
      state?: InterviewState; // 更新后的面试状态
      error?: string; // 错误信息
    }>(`/interview/${interview_id}/advance`, {}),

  /** 结束面试并生成最终报告。 */
  finishInterview: (interview_id: string) =>
    postJson<{
      success: boolean; // 是否成功
      report?: InterviewReport; // 最终报告
      state?: InterviewState; // 最终状态
      error?: string; // 错误信息
    }>(`/interview/${interview_id}/finish`, {}),

  /** 放弃面试:不生成报告,直接标记为 abandoned。 */
  abandonInterview: (interview_id: string) =>
    postJson<{ success: boolean; status: string }>(
      `/interview/${interview_id}/abandon`,
      {},
    ),

  /** 获取面试当前状态(页面刷新/中断恢复时拉取)。 */
  getInterviewState: (interview_id: string) =>
    getJson<{ success: boolean; state: InterviewState }>(
      `/interview/${interview_id}/state`,
    ),

  /** 获取全部面试列表(历史记录页"模拟面试"Tab)。 */
  listInterviews: () =>
    getJson<{ interviews: InterviewListItem[] }>("/interview"),

  /** 删除面试记录。 */
  deleteInterview: (id: string) =>
    del<{ success: boolean }>(`/interview/${id}`),

  // ─────────────────────────── 导出 ───────────────────────────

  /** 导出分析报告为 Word 或 PDF(可选指定某次分析)。 */
  exportAnalysisReport: (format: "word" | "pdf", analysis_id?: string) =>
    postJson<ExportResponse>("/export", { format, analysis_id }),

  /** 列出已导出的报告文件。 */
  listReports: () => getJson<{ reports: ReportFile[] }>("/export/list"),

  /** 拼接报告下载的完整 URL(文件名需 URL 编码)。 */
  downloadUrl: (filename: string) =>
    `${BASE}/export/download/${encodeURIComponent(filename)}`,

  /**
   * 拼接资源(图片/照片)的完整可访问 URL。
   * 后端返回的路径是相对路径(如 /api/assets/xxx.jpg),
   * 前端 BASE 已是完整 URL,需要拼接前缀才能在 <img src> 中使用。
   * @param path - 后端返回的资源路径
   * @returns 完整 URL;空串/已是完整 URL 时原样处理
   */
  assetUrl: (path: string) => {
    if (!path) return ""; // 空路径直接返回空串
    if (path.startsWith("http://") || path.startsWith("https://")) return path; // 已是绝对 URL 直接返回
    // path 形如 /api/assets/xxx.jpg,BASE 形如 http://127.0.0.1:8000/api
    // 去掉 BASE 末尾的 /api,得到 origin,再拼接完整 path
    const origin = BASE.replace(/\/api\/?$/, ""); // 提取站点根地址
    return `${origin}${path}`; // origin + 相对路径 = 可访问完整 URL
  },

  // ─────────────────────────── Ask 对话窗口 ───────────────────────────

  /**
   * 与 Ask 助手进行 SSE 流式对话。
   * 事件类型:thinking(思考中) / answer(回答增量) / error / done / heartbeat(保活)。
   * @param message - 用户输入的消息
   * @param onEvent - 事件回调(payload 含 type 与可选 content)
   * @param opts - 可选的页面上下文(分析 ID/面试 ID/页面标识/自定义上下文)
   * @returns 一个 abort 函数,调用即断开对话流(用于停止生成/组件卸载)
   */
  ask: (
    message: string,
    onEvent: (payload: { type: string; content?: string }) => void,
    opts?: {
      analysis_id?: string; // 关联分析 ID
      interview_id?: string; // 关联面试 ID
      page?: string; // 当前页面标识
      context?: string; // 注入的页面上下文 prompt
    },
  ): (() => void) => {
    const controller = new AbortController(); // 中断控制器
    const url = `${BASE}/ask`; // Ask 对话端点

    // 立即启动异步读取循环(不阻塞调用方)
    (async () => {
      try {
        // 发起流式 POST,声明接受 text/event-stream
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream", // 声明 SSE 内容类型
          },
          body: JSON.stringify({
            message, // 用户消息
            analysis_id: opts?.analysis_id, // 页面上下文:分析 ID
            interview_id: opts?.interview_id, // 页面上下文:面试 ID
            page: opts?.page, // 页面标识
            context: opts?.context, // 额外上下文
          }),
          signal: controller.signal, // 绑定中断信号
        });
        if (!res.ok || !res.body) {
          onEvent({ type: "error", content: `HTTP ${res.status}` }); // 非 2xx 报错回调
          return;
        }
        const reader = res.body.getReader(); // 获取流读取器
        const decoder = new TextDecoder("utf-8"); // UTF-8 解码器
        let buffer = ""; // 累积缓冲区(处理分包)
        while (true) {
          const { value, done } = await reader.read(); // 读取一块数据
          if (done) break; // 流结束
          buffer += decoder.decode(value, { stream: true }); // 解码追加
          // 按双换行切分 SSE 事件,逐条处理
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx); // 单个事件块
            buffer = buffer.slice(idx + 2); // 消费已处理部分
            const lines = raw.split("\n"); // 拆分为行
            const dataLine = lines.find((l) => l.startsWith("data:")); // 找 data: 行
            if (!dataLine) continue; // 无 data 行跳过
            const jsonStr = dataLine.slice(5).trim(); // 去掉 "data:" 前缀
            if (!jsonStr) continue; // 空载荷跳过
            try {
              // 反序列化事件载荷并回调
              const payload = JSON.parse(jsonStr) as {
                type: string; // 事件类型
                content?: string; // 事件内容
              };
              onEvent(payload);
            } catch {
              // 忽略单条解析错误
            }
          }
        }
      } catch (e) {
        // 非主动中断的错误才回调;AbortError 是正常停止
        if ((e as Error).name !== "AbortError") {
          onEvent({ type: "error", content: (e as Error).message || "连接失败" });
        }
      }
    })();

    // 返回 abort 函数:调用即中断对话流
    return () => controller.abort();
  },
};
