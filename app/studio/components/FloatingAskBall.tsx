"use client"; // 客户端组件:需要访问 sessionStorage、window 事件与浏览器 API

// 引入 React hooks、路由与 API 客户端、Markdown 渲染组件
import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import MarkdownText from "./MarkdownText";

/** Ask 对话面板中的单条消息。 */
interface ChatMessage {
  role: "user" | "assistant"; // 消息角色
  content: string; // 消息内容
  error?: boolean; // 是否为错误消息(错误时红色样式)
}

/** 页面中文名映射:路由路径 → 展示名(用于上下文提示与快捷提问)。 */
const PAGE_LABELS: Record<string, string> = {
  "/resumes": "简历管理",
  "/positions": "职位库",
  "/analysis": "面试分析",
  "/interview": "模拟面试",
  "/history": "历史记录",
  "/settings": "设置",
};

/** 快捷提问:按页面动态展示的预设问题(无匹配页时用 default)。 */
const QUICK_ACTIONS: Record<string, string[]> = {
  "/analysis": [
    "这次分析的匹配度如何？",
    "有哪些风险点需要注意？",
    "基于当前分析再出 3 道技术题",
  ],
  "/interview": [
    "当前面试进展如何？",
    "我刚才的回答表现怎么样？",
    "下一阶段会考察什么？",
  ],
  default: [
    "帮我分析一份简历和 JD 的匹配度",
    "什么是 HireMind 的节点 IO？",
  ],
};

/**
 * 从 sessionStorage 读取当前业务上下文,组装成给后端的 context 字符串与 ID。
 *
 * 各页面存储键:
 * - /analysis  → hiremind:analysis-state-v1(analysisId / form / running / result)
 * - /interview → hiremind:interview-state-v1(interviewId / state)
 * - /resumes   → hiremind:resume-state-v1(resumeId / basicsName / title)
 * - /positions → hiremind:position-state-v1(positionId / name / companyName / jobTitle)
 *
 * 读取失败时降级为仅页面信息(不抛错,保证 Ask 球始终可用)。
 * @param page - 当前路由路径
 * @returns {context, analysis_id, interview_id} 注入给后端的上下文
 */
function detectContext(page: string): {
  context: string; // 组装好的上下文描述文本
  analysis_id?: string; // 当前分析 ID(如有)
  interview_id?: string; // 当前面试 ID(如有)
} {
  let context = `用户当前在${PAGE_LABELS[page] || page}页面`; // 基础上下文:页面名
  let analysis_id: string | undefined;
  let interview_id: string | undefined;

  try {
    // ── 分析页:注入分析进度/结果状态 ──
    if (page === "/analysis") {
      const raw = sessionStorage.getItem("hiremind:analysis-state-v1");
      if (raw) {
        const ps = JSON.parse(raw); // 解析持久化状态
        analysis_id = ps.analysisId; // 提取分析 ID
        const form = ps.form || {}; // 表单(公司/岗位)
        const company = form.companyName || ""; // 公司名
        const job = form.jobTitle || ""; // 岗位名
        if (ps.running) {
          // 分析进行中
          context += `，正在进行分析${company ? `（${company}-${job}）` : ""}`;
        } else if (ps.result) {
          // 已有分析结果
          context += `，已生成分析结果（${company || "未指定公司"}-${job || "未指定岗位"}）`;
        } else {
          // 尚未开始
          context += "，尚未开始分析";
        }
      }
    } else if (page === "/interview") { // ── 面试页:注入多阶段/单场面试状态 ──
      const raw = sessionStorage.getItem("hiremind:interview-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        interview_id = ps.interviewId; // 提取面试 ID
        const state = ps.state; // 面试状态对象
        if (state) {
          const isMulti = state.is_multi_stage; // 是否多阶段
          const stages = state.stages_progress || []; // 阶段进度列表
          const stageIdx = state.current_stage_index || 0; // 当前阶段下标
          const status = state.status || ""; // 面试状态
          if (isMulti && stages.length > 0) {
            // 多阶段:报告当前处于第几个阶段
            const cur = stages[stageIdx];
            context += `，多阶段面试第${stageIdx + 1}/${stages.length}阶段`;
            if (cur) context += `（${cur.stage_name || cur.stage_type}，${cur.status}）`;
          } else {
            // 单场面试
            context += `，单场面试（${status}）`;
          }
          if (state.current_question) {
            context += "，当前有未回答的题目"; // 提示有待答题目
          }
        } else {
          context += "，尚未开始面试";
        }
      }
    } else if (page === "/resumes") { // ── 简历页:注入当前查看的简历信息 ──
      const raw = sessionStorage.getItem("hiremind:resume-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        const name = ps.basicsName || ps.name || ""; // 简历姓名
        const title = ps.title || ""; // 求职意向
        if (ps.resumeId) {
          context += `，正在查看简历（ID: ${ps.resumeId}）`;
          if (name) context += `：${name}`;
          if (title) context += `（${title}）`;
        }
      } else {
        context += "，尚未选中简历";
      }
    } else if (page === "/positions") { // ── 职位页:注入当前查看的职位信息 ──
      const raw = sessionStorage.getItem("hiremind:position-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        const name = ps.name || ""; // 职位记录名
        const company = ps.companyName || ""; // 公司名
        const jobTitle = ps.jobTitle || ""; // 岗位名
        if (ps.positionId) {
          context += `，正在查看职位（ID: ${ps.positionId}）`;
          if (name) context += `：${name}`;
          if (company || jobTitle) {
            context += `（${company || "未指定公司"}-${jobTitle || "未指定岗位"}）`;
          }
        }
      } else {
        context += "，尚未选中职位";
      }
    }
  } catch {
    // sessionStorage 读取失败(如隐私模式),降级为仅页面信息,不阻塞对话
  }

  return { context, analysis_id, interview_id };
}

/**
 * 悬浮 Ask 球组件(全局右下角)。
 *
 * 功能:
 * - 悬浮球点击展开 380px 对话面板
 * - SSE 流式对话:thinking(思考中) → token(逐字输出) → done(完成)
 * - 页面上下文感知:detectContext 读取当前页面业务状态注入后端
 * - Markdown 渲染助手消息(代码块/表格/列表等)
 * - 快捷提问卡片按页面动态展示
 * - 支持「新对话」清空与「停止生成」
 */
export default function FloatingAskBall() {
  const pathname = usePathname(); // 当前路由(决定上下文与快捷提问)
  const [mounted, setMounted] = useState(false); // 已挂载标记(避免 SSR hydration mismatch)
  const [open, setOpen] = useState(false); // 面板是否展开
  const [messages, setMessages] = useState<ChatMessage[]>([]); // 对话消息列表
  const [input, setInput] = useState(""); // 输入框内容
  const [loading, setLoading] = useState(false); // 是否正在生成(禁用输入/显示加载)
  const messagesEndRef = useRef<HTMLDivElement>(null); // 消息区底部锚点(自动滚动)
  const abortRef = useRef<(() => void) | null>(null); // 当前对话流的 abort 函数(停止生成)

  // 挂载标记:避免服务端渲染时执行浏览器专属逻辑
  useEffect(() => {
    setMounted(true);
  }, []);

  // 自动滚动:面板打开且消息变化时,滚动到最新消息
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); // 平滑滚动到底部
    }
  }, [messages, open]); // 依赖消息列表与面板状态

  // 组件卸载时断开进行中的对话流(防止泄漏)
  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  /**
   * 发送消息:调用 api.ask 建立 SSE 流式对话。
   * 处理事件类型:
   * - thinking:清空占位,等待 token
   * - status:临时显示阶段状态(如"正在调用工具")
   * - token:逐字追加答案(首个 token 清掉状态文本)
   * - answer:最终完整答案(覆盖,兼容非流式)
   * - error:显示错误消息
   * - done:结束加载态
   * @param text - 可选的消息文本;不传则用输入框当前内容
   */
  const handleSend = useCallback(
    (text?: string) => {
      const msg = (text ?? input).trim(); // 取输入框内容并去空白
      if (!msg || loading) return; // 空消息或正在生成时忽略

      // 探测当前页面上下文(注入后端 prompt)
      const { context, analysis_id, interview_id } = detectContext(pathname);

      // 追加用户消息 + 占位 assistant 消息
      setMessages((prev) => [...prev, { role: "user", content: msg }]);
      setInput(""); // 清空输入框
      setLoading(true); // 进入加载态
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]); // 占位空消息

      let assistantIdx = -1; // 当前 assistant 消息在列表中的下标(延迟定位)
      let tokenStarted = false; // 首个 token 是否已到达(用于清除状态文本)
      // 建立 SSE 流式连接,保存 abort 函数
      abortRef.current = api.ask(
        msg,
        (payload) => {
          // ── thinking:模型开始思考,清空占位内容 ──
          if (payload.type === "thinking") {
            setMessages((prev) => {
              assistantIdx = prev.length - 1; // 定位占位消息
              const next = [...prev];
              // 收到 thinking:清空占位内容,等待 token 流式填充
              next[assistantIdx] = { role: "assistant", content: "" };
              return next;
            });
          } else if (payload.type === "status") { // ── status:阶段状态(如"正在调用工具"),token 开始后被覆盖 ──
            if (!tokenStarted) {
              // token 未开始时才显示状态文本
              setMessages((prev) => {
                const next = [...prev];
                if (assistantIdx < 0) assistantIdx = next.length - 1;
                // 仅在内容为空或仍是状态文本时显示
                next[assistantIdx] = {
                  role: "assistant",
                  content: payload.content || "",
                };
                return next;
              });
            }
          } else if (payload.type === "token") { // ── token:流式 token,逐字追加到当前 assistant 消息 ──
            // 首个 token 到达时清掉状态文本,开始填入实际答案
            if (!tokenStarted) {
              tokenStarted = true;
              setMessages((prev) => {
                const next = [...prev];
                if (assistantIdx < 0) assistantIdx = next.length - 1;
                next[assistantIdx] = {
                  role: "assistant",
                  content: payload.content || "",
                };
                return next;
              });
            } else {
              // 后续 token:追加到已有内容末尾
              setMessages((prev) => {
                const next = [...prev];
                if (assistantIdx < 0) assistantIdx = next.length - 1;
                const cur = next[assistantIdx];
                next[assistantIdx] = {
                  role: "assistant",
                  content: (cur.content || "") + (payload.content || ""),
                };
                return next;
              });
            }
          } else if (payload.type === "answer") { // ── answer:最终完整答案,覆盖(确保一致性,兼容非流式场景) ──
            setMessages((prev) => {
              const next = [...prev];
              if (assistantIdx < 0) assistantIdx = next.length - 1;
              next[assistantIdx] = {
                role: "assistant",
                content: payload.content || "",
              };
              return next;
            });
            setLoading(false); // 结束加载态
          } else if (payload.type === "error") { // ── error:显示错误消息(红色样式) ──
            setMessages((prev) => {
              const next = [...prev];
              if (assistantIdx < 0) assistantIdx = next.length - 1;
              next[assistantIdx] = {
                role: "assistant",
                content: payload.content || "处理出错",
                error: true, // 标记为错误消息
              };
              return next;
            });
            setLoading(false);
          } else if (payload.type === "done") { // ── done:流结束,结束加载态 ──
            setLoading(false);
          }
        },
        // 传入页面上下文:分析/面试 ID + 页面标识 + 上下文描述
        { analysis_id, interview_id, page: pathname, context },
      );
    },
    [input, loading, pathname], // 依赖:输入内容/加载态/当前路由
  );

  /** 输入框按键处理:Enter 发送,Shift+Enter 换行。 */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // 阻止默认换行
      handleSend(); // 发送消息
    }
  }

  /** 新建对话:中断进行中的流并清空消息。 */
  function handleNewConversation() {
    abortRef.current?.(); // 断开当前对话流
    setMessages([]); // 清空消息
    setLoading(false); // 重置加载态
    setInput(""); // 清空输入框
  }

  const pageLabel = PAGE_LABELS[pathname] || ""; // 当前页面中文名
  const quickActions = QUICK_ACTIONS[pathname] || QUICK_ACTIONS.default; // 当前页面快捷提问

  // 服务端渲染时不显示(避免 hydration mismatch:localStorage/sessionStorage 仅客户端可用)
  if (!mounted) return null;

  return (
    <>
      {/* ── 悬浮球(面板关闭时显示) ── */}
      {!open && (
        <button
          onClick={() => setOpen(true)} // 点击展开面板
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-105 transition-transform"
          style={{
            background: "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)", // 品牌渐变
            boxShadow: "0 4px 20px rgba(234,88,12,0.4)", // 品牌橙色阴影
          }}
          title="Ask HireMind"
        >
          {/* 对话气泡图标 */}
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 3v-3z"
            />
          </svg>
        </button>
      )}

      {/* ── 对话面板(展开时显示) ── */}
      {open && (
        <div
          className="fixed bottom-6 right-6 z-50 flex flex-col rounded-2xl shadow-2xl border overflow-hidden"
          style={{
            width: "380px", // 固定宽度
            height: "min(560px, calc(100vh - 48px))", // 高度自适应视口
            borderColor: "var(--border)",
            background: "var(--bg-elevated, #fff)",
          }}
        >
          {/* ── 顶栏:Logo + 标题 + 操作按钮 ── */}
          <div
            className="flex items-center justify-between px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--border)" }}
          >
            {/* 左侧:Logo + 标题 + 当前页面 */}
            <div className="flex items-center gap-2">
              {/* 品牌 Logo 方块 */}
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                style={{
                  background:
                    "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                }}
              >
                H
              </div>
              <div>
                {/* 标题 */}
                <div className="text-sm font-semibold text-stone-800">
                  Ask HireMind
                </div>
                {/* 当前页面名(小字) */}
                {pageLabel && (
                  <div className="text-[10px] text-stone-400">
                    当前：{pageLabel}
                  </div>
                )}
              </div>
            </div>
            {/* 右侧:新对话 + 关闭按钮 */}
            <div className="flex items-center gap-1">
              {/* 新对话按钮(有消息时才显示) */}
              {messages.length > 0 && (
                <button
                  onClick={handleNewConversation}
                  className="px-2 py-1 text-[11px] rounded-md border text-stone-500 hover:text-stone-800 hover:bg-stone-100 transition"
                  style={{ borderColor: "var(--border)" }}
                  title="新建对话"
                >
                  新对话
                </button>
              )}
              {/* 关闭按钮:中断流并收起面板 */}
              <button
                onClick={() => {
                  abortRef.current?.(); // 断开对话流
                  setOpen(false); // 收起面板
                }}
                className="w-7 h-7 flex items-center justify-center rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition"
              >
                {/* X 关闭图标 */}
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* ── 消息区 ── */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {/* 空状态:欢迎语 + 快捷提问 */}
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                {/* 欢迎 Logo */}
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center text-white font-bold text-lg mb-3"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                  }}
                >
                  H
                </div>
                <h2 className="text-sm font-medium text-stone-700 mb-1">
                  有什么可以帮你？
                </h2>
                {/* 页面感知提示文案 */}
                <p className="text-xs text-stone-400 max-w-xs mb-4">
                  我知道你当前在{pageLabel || "哪个"}页面，
                  {pageLabel === "面试分析"
                    ? "分析结果出来后我能看到全部内容" // 分析页文案
                    : pageLabel === "模拟面试"
                      ? "面试的出题和阶段信息我都知道" // 面试页文案
                      : "随时提问面试相关问题"} {/* 其他页默认文案 */}
                </p>
                {/* 快捷提问按钮列表 */}
                <div className="flex flex-col gap-2 w-full">
                  {quickActions.map((q) => (
                    <button
                      key={q}
                      onClick={() => handleSend(q)} // 点击直接发送该问题
                      className="text-left text-xs px-3 py-2 rounded-lg border text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /* 消息列表 */
              <div className="space-y-3">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    // 用户消息靠右,助手消息靠左
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {/* 消息气泡 */}
                    <div
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "text-white" // 用户消息:白字
                          : msg.error
                            ? "bg-red-50 text-red-700 border border-red-200" // 错误:红底红字
                            : "bg-white border" // 助手消息:白底描边
                      }`}
                      style={
                        msg.role === "user"
                          ? {
                              // 用户消息:品牌渐变底
                              background:
                                "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                            }
                          : { borderColor: "var(--border)" } // 助手消息:边框色
                      }
                    >
                      {/* 助手正常消息用 Markdown 渲染;用户消息/错误消息用纯文本 */}
                      {msg.role === "assistant" && !msg.error ? (
                        <MarkdownText
                          content={msg.content || "…"}
                          className="md-bubble break-words"
                        />
                      ) : (
                        <div className="whitespace-pre-wrap break-words">
                          {msg.content || "…"}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {/* 自动滚动锚点 */}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* ── 输入区 ── */}
          <div
            className="shrink-0 px-3 py-3 border-t"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-card, #fafafa)",
            }}
          >
            <div className="flex items-end gap-2">
              {/* 消息输入框:Enter 发送,Shift+Enter 换行 */}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入问题，Enter 发送"
                rows={1}
                disabled={loading} // 生成中禁用输入
                className="flex-1 resize-none rounded-lg px-3 py-2 text-xs outline-none border focus:ring-1 transition disabled:opacity-50 max-h-24"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-card, white)",
                }}
              />
              {/* 发送按钮:加载中显示旋转图标 */}
              <button
                onClick={() => handleSend()}
                disabled={loading || !input.trim()} // 生成中或空输入时禁用
                className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white disabled:opacity-40 transition"
                style={{
                  background:
                    "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                }}
              >
                {loading ? (
                  // 加载中:旋转圆圈
                  <svg
                    className="w-4 h-4 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 12a8 8 0 018-8"
                    />
                  </svg>
                ) : (
                  // 正常:纸飞机图标
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
