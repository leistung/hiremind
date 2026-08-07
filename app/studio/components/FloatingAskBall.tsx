"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import MarkdownText from "./MarkdownText";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

// 页面中文名映射
const PAGE_LABELS: Record<string, string> = {
  "/resumes": "简历管理",
  "/positions": "职位库",
  "/analysis": "面试分析",
  "/interview": "模拟面试",
  "/history": "历史记录",
  "/settings": "设置",
};

// 快捷提问(根据页面动态展示)
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

/** 从 sessionStorage 读取当前业务上下文,组装成给后端的 context 字符串 + ids */
function detectContext(page: string): {
  context: string;
  analysis_id?: string;
  interview_id?: string;
} {
  let context = `用户当前在${PAGE_LABELS[page] || page}页面`;
  let analysis_id: string | undefined;
  let interview_id: string | undefined;

  try {
    if (page === "/analysis") {
      const raw = sessionStorage.getItem("hiremind:analysis-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        analysis_id = ps.analysisId;
        const form = ps.form || {};
        const company = form.companyName || "";
        const job = form.jobTitle || "";
        if (ps.running) {
          context += `，正在进行分析${company ? `（${company}-${job}）` : ""}`;
        } else if (ps.result) {
          context += `，已生成分析结果（${company || "未指定公司"}-${job || "未指定岗位"}）`;
        } else {
          context += "，尚未开始分析";
        }
      }
    } else if (page === "/interview") {
      const raw = sessionStorage.getItem("hiremind:interview-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        interview_id = ps.interviewId;
        const state = ps.state;
        if (state) {
          const isMulti = state.is_multi_stage;
          const stages = state.stages_progress || [];
          const stageIdx = state.current_stage_index || 0;
          const status = state.status || "";
          if (isMulti && stages.length > 0) {
            const cur = stages[stageIdx];
            context += `，多阶段面试第${stageIdx + 1}/${stages.length}阶段`;
            if (cur) context += `（${cur.stage_name || cur.stage_type}，${cur.status}）`;
          } else {
            context += `，单场面试（${status}）`;
          }
          if (state.current_question) {
            context += "，当前有未回答的题目";
          }
        } else {
          context += "，尚未开始面试";
        }
      }
    } else if (page === "/resumes") {
      // 简历页:从 sessionStorage 读取当前查看的简历信息
      const raw = sessionStorage.getItem("hiremind:resume-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        const name = ps.basicsName || ps.name || "";
        const title = ps.title || "";
        if (ps.resumeId) {
          context += `，正在查看简历（ID: ${ps.resumeId}）`;
          if (name) context += `：${name}`;
          if (title) context += `（${title}）`;
        }
      } else {
        context += "，尚未选中简历";
      }
    } else if (page === "/positions") {
      // 职位页:从 sessionStorage 读取当前查看的职位信息
      const raw = sessionStorage.getItem("hiremind:position-state-v1");
      if (raw) {
        const ps = JSON.parse(raw);
        const name = ps.name || "";
        const company = ps.companyName || "";
        const jobTitle = ps.jobTitle || "";
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
    // sessionStorage 读取失败,降级为仅页面信息
  }

  return { context, analysis_id, interview_id };
}

export default function FloatingAskBall() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 自动滚动
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, open]);

  // 卸载时断开
  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  const handleSend = useCallback(
    (text?: string) => {
      const msg = (text ?? input).trim();
      if (!msg || loading) return;

      const { context, analysis_id, interview_id } = detectContext(pathname);

      setMessages((prev) => [...prev, { role: "user", content: msg }]);
      setInput("");
      setLoading(true);
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      let assistantIdx = -1;
      let tokenStarted = false;
      abortRef.current = api.ask(
        msg,
        (payload) => {
          if (payload.type === "thinking") {
            setMessages((prev) => {
              assistantIdx = prev.length - 1;
              const next = [...prev];
              // 收到 thinking:清空占位内容,等待 token 流式填充
              next[assistantIdx] = { role: "assistant", content: "" };
              return next;
            });
          } else if (payload.type === "status") {
            // 阶段状态(如"正在调用工具"):临时显示,token 开始后会被覆盖
            if (!tokenStarted) {
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
          } else if (payload.type === "token") {
            // 流式 token:逐字追加到当前 assistant 消息
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
          } else if (payload.type === "answer") {
            // 最终完整答案:覆盖(确保一致性,兼容非流式场景)
            setMessages((prev) => {
              const next = [...prev];
              if (assistantIdx < 0) assistantIdx = next.length - 1;
              next[assistantIdx] = {
                role: "assistant",
                content: payload.content || "",
              };
              return next;
            });
            setLoading(false);
          } else if (payload.type === "error") {
            setMessages((prev) => {
              const next = [...prev];
              if (assistantIdx < 0) assistantIdx = next.length - 1;
              next[assistantIdx] = {
                role: "assistant",
                content: payload.content || "处理出错",
                error: true,
              };
              return next;
            });
            setLoading(false);
          } else if (payload.type === "done") {
            setLoading(false);
          }
        },
        { analysis_id, interview_id, page: pathname, context },
      );
    },
    [input, loading, pathname],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleNewConversation() {
    abortRef.current?.();
    setMessages([]);
    setLoading(false);
    setInput("");
  }

  const pageLabel = PAGE_LABELS[pathname] || "";
  const quickActions =
    QUICK_ACTIONS[pathname] || QUICK_ACTIONS.default;

  // 服务端渲染时不显示(避免 hydration mismatch)
  if (!mounted) return null;

  return (
    <>
      {/* 悬浮球 */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-105 transition-transform"
          style={{
            background: "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
            boxShadow: "0 4px 20px rgba(234,88,12,0.4)",
          }}
          title="Ask HireMind"
        >
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

      {/* 对话面板 */}
      {open && (
        <div
          className="fixed bottom-6 right-6 z-50 flex flex-col rounded-2xl shadow-2xl border overflow-hidden"
          style={{
            width: "380px",
            height: "min(560px, calc(100vh - 48px))",
            borderColor: "var(--border)",
            background: "var(--bg-elevated, #fff)",
          }}
        >
          {/* 顶栏 */}
          <div
            className="flex items-center justify-between px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="flex items-center gap-2">
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
                <div className="text-sm font-semibold text-stone-800">
                  Ask HireMind
                </div>
                {pageLabel && (
                  <div className="text-[10px] text-stone-400">
                    当前：{pageLabel}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
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
              <button
                onClick={() => {
                  abortRef.current?.();
                  setOpen(false);
                }}
                className="w-7 h-7 flex items-center justify-center rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition"
              >
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

          {/* 消息区 */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
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
                <p className="text-xs text-stone-400 max-w-xs mb-4">
                  我知道你当前在{pageLabel || "哪个"}页面，
                  {pageLabel === "面试分析"
                    ? "分析结果出来后我能看到全部内容"
                    : pageLabel === "模拟面试"
                      ? "面试的出题和阶段信息我都知道"
                      : "随时提问面试相关问题"}
                </p>
                {/* 快捷提问 */}
                <div className="flex flex-col gap-2 w-full">
                  {quickActions.map((q) => (
                    <button
                      key={q}
                      onClick={() => handleSend(q)}
                      className="text-left text-xs px-3 py-2 rounded-lg border text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "text-white"
                          : msg.error
                            ? "bg-red-50 text-red-700 border border-red-200"
                            : "bg-white border"
                      }`}
                      style={
                        msg.role === "user"
                          ? {
                              background:
                                "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                            }
                          : { borderColor: "var(--border)" }
                      }
                    >
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
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* 输入区 */}
          <div
            className="shrink-0 px-3 py-3 border-t"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-card, #fafafa)",
            }}
          >
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入问题，Enter 发送"
                rows={1}
                disabled={loading}
                className="flex-1 resize-none rounded-lg px-3 py-2 text-xs outline-none border focus:ring-1 transition disabled:opacity-50 max-h-24"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--bg-card, white)",
                }}
              />
              <button
                onClick={() => handleSend()}
                disabled={loading || !input.trim()}
                className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white disabled:opacity-40 transition"
                style={{
                  background:
                    "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                }}
              >
                {loading ? (
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
