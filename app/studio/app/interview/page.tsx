"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { scoreColor } from "@/lib/utils";
import type {
  InterviewReport,
  InterviewState,
} from "@/lib/types";

type Phase = "idle" | "asking" | "answering" | "evaluating" | "next" | "finished";

interface ChatItem {
  kind: "question" | "answer" | "eval" | "system";
  content: string;
  focus?: string;
  rationale?: string;
  referenceAnswer?: string;
  evaluation?: string;
  score?: number;
  improvements?: string[];
  ts: number;
}

export default function InterviewPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <InterviewPage />
    </Suspense>
  );
}

function InterviewPage() {
  const searchParams = useSearchParams();
  const presetSessionId = searchParams.get("session") || "";

  const [state, setState] = useState<InterviewState | null>(null);
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [maxTurns, setMaxTurns] = useState(8);

  const scrollRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (presetSessionId) {
      startWithSession(presetSessionId);
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat, phase]);

  async function startWithSession(sessionId: string) {
    setStarting(true);
    setError("");
    setChat([]);
    setReport(null);
    try {
      const r = await api.startInterview(sessionId, maxTurns);
      if (!r.success || !r.state) {
        setError(r.error || "启动失败,请先在分析页生成报告");
        setPhase("idle");
        return;
      }
      setState(r.state);
      setChat([
        {
          kind: "system",
          content: `面试开始 · ${r.state.company_name} · ${r.state.job_title} · 共 ${r.state.max_turns} 轮`,
          ts: Date.now(),
        },
        {
          kind: "question",
          content: r.state.current_question || "",
          focus: r.state.current_focus || undefined,
          rationale: r.state.current_rationale || undefined,
          referenceAnswer: r.state.current_reference_answer || undefined,
          ts: Date.now(),
        },
      ]);
      setPhase("answering");
      setTimeout(() => answerRef.current?.focus(), 100);
    } catch {
      setError("请求失败,请检查后端服务");
      setPhase("idle");
    } finally {
      setStarting(false);
    }
  }

  async function submitAnswer() {
    if (!state || !answer.trim() || phase !== "answering") return;
    setPhase("evaluating");
    setError("");
    const answerText = answer.trim();
    setAnswer("");

    // 先把回答塞进对话
    setChat((c) => [
      ...c,
      { kind: "answer", content: answerText, ts: Date.now() },
    ]);

    try {
      const r = await api.submitInterviewAnswer(state.interview_id, answerText);
      if (!r.success || !r.turn) {
        setError(r.error || "评价失败");
        setPhase("answering");
        return;
      }
      // 把评价塞进对话
      setChat((c) => [
        ...c,
        {
          kind: "eval",
          content: r.turn!.evaluation,
          score: r.turn!.score,
          improvements: r.turn!.improvements,
          ts: Date.now(),
        },
      ]);
      setState(r.state || state);
      setPhase("next");
    } catch {
      setError("网络错误");
      setPhase("answering");
    }
  }

  async function nextQuestion() {
    if (!state || phase !== "next") return;
    setPhase("asking");
    setError("");
    try {
      const r = await api.nextInterviewQuestion(state.interview_id);
      if (!r.success) {
        setError(r.error || "出题失败");
        setPhase("next");
        return;
      }
      if (r.finished) {
        // 面试结束
        setReport(r.report || null);
        setState(r.state || state);
        setChat((c) => [
          ...c,
          {
            kind: "system",
            content: "面试结束,正在生成最终报告…",
            ts: Date.now(),
          },
        ]);
        setPhase("finished");
      } else {
        // 下一题
        setState(r.state || state);
        setChat((c) => [
          ...c,
          {
            kind: "question",
            content: r.next_question || "",
            focus: r.state?.current_focus || undefined,
            rationale: r.state?.current_rationale || undefined,
            referenceAnswer: r.state?.current_reference_answer || undefined,
            ts: Date.now(),
          },
        ]);
        setPhase("answering");
        setTimeout(() => answerRef.current?.focus(), 100);
      }
    } catch {
      setError("网络错误");
      setPhase("next");
    }
  }

  async function finishNow() {
    if (!state) return;
    if (!confirm("确定要提前结束面试并生成报告吗?")) return;
    setPhase("asking");
    try {
      const r = await api.finishInterview(state.interview_id);
      if (!r.success || !r.report) {
        setError(r.error || "结束失败");
        setPhase("next");
        return;
      }
      setReport(r.report);
      setState(r.state || state);
      setChat((c) => [
        ...c,
        { kind: "system", content: "面试已结束", ts: Date.now() },
      ]);
      setPhase("finished");
    } catch {
      setError("网络错误");
      setPhase("next");
    }
  }

  const started = state !== null;

  return (
    <div className="h-screen flex flex-col">
      {/* 右侧:对话区 / 启动区 / 报告区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!started && phase === "idle" ? (
          <StartView
            presetSessionId={presetSessionId}
            starting={starting}
            maxTurns={maxTurns}
            setMaxTurns={setMaxTurns}
            onStart={startWithSession}
            error={error}
          />
        ) : (
          <>
            {/* 顶部信息条 */}
            {state && (
              <div
                className="px-6 py-3 border-b flex items-center justify-between shrink-0"
                style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
              >
                <div className="flex items-center gap-3">
                  <div className="text-[14px] font-semibold text-stone-800">
                    {state.company_name} · {state.job_title}
                  </div>
                  <span className="badge badge-muted">
                    {state.turn_index} / {state.max_turns} 轮
                  </span>
                  {phase === "finished" && (
                    <span className="badge badge-success">已完成</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Link href="/history" className="btn btn-ghost text-[12px]">
                    历史记录
                  </Link>
                  {phase !== "finished" && (
                    <button onClick={finishNow} className="btn btn-ghost text-[12px]">
                      提前结束
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 对话流 */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-[760px] mx-auto space-y-4">
                {chat.map((item, i) => (
                  <ChatBubble key={i} item={item} />
                ))}
                {phase === "evaluating" && (
                  <TypingBubble text="AI 正在评估你的回答…" />
                )}
                {phase === "asking" && (
                  <TypingBubble text="AI 正在准备下一题…" />
                )}
              </div>
            </div>

            {/* 底部操作区 */}
            {state && phase === "answering" && (
              <div
                className="px-6 py-4 border-t shrink-0"
                style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
              >
                <div className="max-w-[760px] mx-auto">
                  <textarea
                    ref={answerRef}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        submitAnswer();
                      }
                    }}
                    rows={3}
                    className="input"
                    placeholder="在这里输入你的回答…  (⌘+Enter 提交)"
                    disabled={phase !== "answering"}
                  />
                  <div className="flex items-center justify-between mt-2">
                    <div className="text-[11px] text-stone-400">
                      建议结合参考答案组织语言,但不要照搬
                    </div>
                    <button
                      onClick={submitAnswer}
                      disabled={!answer.trim() || phase !== "answering"}
                      className="btn btn-primary"
                    >
                      提交回答
                    </button>
                  </div>
                </div>
              </div>
            )}

            {state && phase === "next" && (
              <div
                className="px-6 py-4 border-t shrink-0"
                style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
              >
                <div className="max-w-[760px] mx-auto flex items-center justify-between">
                  <div className="text-[12px] text-stone-500">
                    评价已生成,继续下一题?
                  </div>
                  <div className="flex gap-2">
                    <button onClick={finishNow} className="btn btn-ghost">
                      结束面试
                    </button>
                    <button onClick={nextQuestion} className="btn btn-primary">
                      下一题 →
                    </button>
                  </div>
                </div>
              </div>
            )}

            {phase === "finished" && report && (
              <FinalReportView report={report} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── 启动视图 ──
function StartView({
  presetSessionId,
  starting,
  maxTurns,
  setMaxTurns,
  onStart,
  error,
}: {
  presetSessionId: string;
  starting: boolean;
  maxTurns: number;
  setMaxTurns: (n: number) => void;
  onStart: (sessionId: string) => void;
  error: string;
}) {
  const [sessionId, setSessionId] = useState(presetSessionId);

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-[480px] w-full">
        <div className="text-center mb-8">
          <div
            className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
            style={{
              background: "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
              boxShadow: "0 8px 24px -8px rgba(194, 65, 12, 0.5)",
            }}
          >
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <h1 className="text-[24px] font-semibold text-stone-800 mb-2">
            AI 模拟面试
          </h1>
          <p className="text-[13px] text-stone-500 leading-relaxed">
            基于面试分析报告,AI 将自适应提问,逐题给出评价,最终生成面试结果与学习建议
          </p>
        </div>

        <div className="card p-5 space-y-4">
          <div>
            <label className="label">分析会话 ID *</label>
            <input
              className="input"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="粘贴分析页生成的 session_id"
            />
            <div className="text-[11px] text-stone-400 mt-1.5">
              在
              <Link href="/analysis" className="text-orange-700 mx-1">面试分析</Link>
              页生成报告后,可点击「去模拟面试」直接进入
            </div>
          </div>
          <div>
            <label className="label">面试轮数</label>
            <div className="flex items-center gap-2">
              {[5, 8, 10, 12].map((n) => (
                <button
                  key={n}
                  onClick={() => setMaxTurns(n)}
                  className="btn btn-secondary flex-1"
                  style={
                    maxTurns === n
                      ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                      : undefined
                  }
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <div
              className="px-3 py-2 rounded-lg text-[12px]"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}
          <button
            onClick={() => onStart(sessionId)}
            disabled={!sessionId.trim() || starting}
            className="btn btn-primary w-full"
            style={{ padding: "10px 16px", fontSize: 14 }}
          >
            {starting ? "启动中…" : "开始面试"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 对话气泡 ──
function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "system") {
    return (
      <div className="flex justify-center">
        <div
          className="px-3 py-1.5 rounded-full text-[11px] text-stone-500"
          style={{ background: "var(--bg-muted)" }}
        >
          {item.content}
        </div>
      </div>
    );
  }

  if (item.kind === "question") {
    return (
      <div className="flex gap-3">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold shrink-0"
          style={{ background: "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)" }}
        >
          AI
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="rounded-2xl rounded-tl-sm px-4 py-3 inline-block max-w-full"
            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
          >
            {item.focus && (
              <div className="badge badge-accent mb-2">{item.focus}</div>
            )}
            <div className="text-[13px] text-stone-800 leading-relaxed whitespace-pre-wrap">
              {item.content}
            </div>
          </div>
          {(item.rationale || item.referenceAnswer) && (
            <details className="mt-2 ml-1">
              <summary className="text-[11px] text-stone-400 cursor-pointer hover:text-orange-700">
                查看出题分析 & 参考答案
              </summary>
              <div className="mt-2 space-y-2">
                {item.rationale && (
                  <div className="p-2.5 rounded-lg text-[12px]" style={{ background: "var(--info-soft)", color: "var(--info)" }}>
                    <div className="font-semibold mb-1">为什么会出这个题</div>
                    <div className="leading-relaxed">{item.rationale}</div>
                  </div>
                )}
                {item.referenceAnswer && (
                  <div className="p-2.5 rounded-lg text-[12px]" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
                    <div className="font-semibold mb-1">基于简历的参考答案</div>
                    <div className="leading-relaxed whitespace-pre-wrap">{item.referenceAnswer}</div>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }

  if (item.kind === "answer") {
    return (
      <div className="flex gap-3 flex-row-reverse">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0"
          style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}
        >
          我
        </div>
        <div
          className="rounded-2xl rounded-tr-sm px-4 py-3 max-w-[80%]"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          <div className="text-[13px] leading-relaxed whitespace-pre-wrap">{item.content}</div>
        </div>
      </div>
    );
  }

  // eval
  const score = item.score ?? 0;
  const sc = scoreColor(score);
  const scColor = sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";
  return (
    <div className="flex gap-3">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0"
        style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="rounded-2xl rounded-tl-sm px-4 py-3 inline-block max-w-full fade-in"
          style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-semibold text-stone-500">本题评价</span>
            <span
              className="badge"
              style={{ background: `${scColor}20`, color: scColor }}
            >
              {score} 分
            </span>
          </div>
          <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
            {item.content}
          </div>
          {item.improvements && item.improvements.length > 0 && (
            <div className="mt-2 pt-2 border-t" style={{ borderColor: "var(--border)" }}>
              <div className="text-[11px] text-stone-500 font-semibold mb-1">改进建议</div>
              <ul className="space-y-0.5">
                {item.improvements.map((it, i) => (
                  <li key={i} className="text-[12px] text-stone-600 flex gap-1.5">
                    <span style={{ color: scColor }}>•</span>
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TypingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold shrink-0"
        style={{ background: "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)" }}
      >
        AI
      </div>
      <div
        className="rounded-2xl rounded-tl-sm px-4 py-3 inline-flex items-center gap-2"
        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
      >
        <span className="pulse-soft text-stone-400">●●●</span>
        <span className="text-[12px] text-stone-500">{text}</span>
      </div>
    </div>
  );
}

// ── 最终报告 ──
function FinalReportView({ report }: { report: InterviewReport }) {
  const score = report.overall_score || 0;
  const sc = scoreColor(score);
  const scColor = sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div
      className="border-t overflow-y-auto shrink-0"
      style={{ background: "var(--bg-muted)", borderColor: "var(--border)", maxHeight: "55vh" }}
    >
      <div className="max-w-[760px] mx-auto p-6 fade-in">
        <div className="flex items-center gap-2 mb-4">
          <div className="section-title mb-0">面试最终报告</div>
        </div>

        {/* 总分 */}
        <div className="card p-5 mb-4">
          <div className="flex items-center gap-5">
            <div className="relative w-20 h-20 shrink-0">
              <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="34" fill="none" stroke="var(--border)" strokeWidth="6" />
                <circle
                  cx="40"
                  cy="40"
                  r="34"
                  fill="none"
                  stroke={scColor}
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={`${(score / 100) * 214} 214`}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[22px] font-bold" style={{ color: scColor }}>{score}</span>
              </div>
            </div>
            <div className="flex-1">
              <div className="text-[15px] font-semibold text-stone-800 mb-1">
                {report.summary.split("\n")[0] || "综合评估"}
              </div>
              <div className="text-[12px] text-stone-500">
                完成 {report.rounds_completed} 轮 · {report.company_name} · {report.job_title}
              </div>
            </div>
          </div>
        </div>

        {/* 总评 */}
        {report.summary && (
          <div className="card p-4 mb-4">
            <div className="text-[11px] font-semibold text-stone-500 mb-1.5">总评</div>
            <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
              {report.summary}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mb-4">
          {/* 优势 */}
          <div className="card p-4">
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-1.5"
              style={{ color: "var(--success)" }}
            >
              <span>✓</span> 表现优势
            </div>
            {report.strengths.length === 0 ? (
              <div className="text-[12px] text-stone-400">—</div>
            ) : (
              <ul className="space-y-1">
                {report.strengths.map((s, i) => (
                  <li key={i} className="text-[12px] text-stone-700 flex gap-1.5">
                    <span style={{ color: "var(--success)" }}>•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 不足 */}
          <div className="card p-4">
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-1.5"
              style={{ color: "var(--danger)" }}
            >
              <span>!</span> 薄弱环节
            </div>
            {report.weak_areas.length === 0 ? (
              <div className="text-[12px] text-stone-400">—</div>
            ) : (
              <ul className="space-y-1">
                {report.weak_areas.map((s, i) => (
                  <li key={i} className="text-[12px] text-stone-700 flex gap-1.5">
                    <span style={{ color: "var(--danger)" }}>•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 学习建议 */}
        {report.learning_suggestions.length > 0 && (
          <div className="card p-4">
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-1.5"
              style={{ color: "var(--accent)" }}
            >
              <span>📚</span> 学习建议
            </div>
            <ul className="space-y-1.5">
              {report.learning_suggestions.map((s, i) => (
                <li
                  key={i}
                  className="text-[12px] text-stone-700 p-2 rounded"
                  style={{ background: "var(--accent-bg)" }}
                >
                  {i + 1}. {s}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
