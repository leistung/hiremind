"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { formatDate, relativeTime, scoreColor } from "@/lib/utils";
import FullscreenPreview, { FullscreenButton } from "@/components/FullscreenPreview";
import type {
  AnalysisDetail,
  AnalysisSummary,
  InterviewListItem,
  InterviewReportDetail,
  InterviewResult,
  InterviewRound,
  InterviewTurn,
  Question,
} from "@/lib/types";

type Tab = "analysis" | "interview";

export default function HistoryPage() {
  const [tab, setTab] = useState<Tab>("analysis");

  // 分析历史
  const [analysisItems, setAnalysisItems] = useState<AnalysisSummary[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState("");
  const [analysisDetail, setAnalysisDetail] = useState<AnalysisDetail | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);

  // 面试历史
  const [interviewItems, setInterviewItems] = useState<InterviewListItem[]>([]);
  const [selectedInterviewId, setSelectedInterviewId] = useState("");
  const [interviewDetail, setInterviewDetail] = useState<InterviewReportDetail | null>(null);
  const [loadingInterview, setLoadingInterview] = useState(false);

  const [loadingList, setLoadingList] = useState(false);
  // 待删除项(用于确认弹窗)
  const [pendingDelete, setPendingDelete] = useState<{ type: Tab; id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // 删除记录
  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError("");
    try {
      if (pendingDelete.type === "analysis") {
        await api.deleteAnalysis(pendingDelete.id);
        // 清除选中状态
        if (selectedAnalysisId === pendingDelete.id) {
          setSelectedAnalysisId("");
          setAnalysisDetail(null);
        }
        // 刷新列表
        const r = await api.listAnalyses();
        setAnalysisItems(r.analyses || []);
      } else {
        await api.deleteInterview(pendingDelete.id);
        if (selectedInterviewId === pendingDelete.id) {
          setSelectedInterviewId("");
          setInterviewDetail(null);
        }
        const r = await api.listInterviews();
        setInterviewItems(r.interviews || []);
      }
      setPendingDelete(null);
    } catch (err) {
      // 删除失败时保留弹窗,显示错误,让用户重试或取消
      setDeleteError(
        err instanceof Error ? err.message : "删除失败,请检查后端服务后重试"
      );
    } finally {
      setDeleting(false);
    }
  }

  // 拉取列表
  useEffect(() => {
    if (tab === "analysis") {
      setLoadingList(true);
      api.listAnalyses()
        .then((r) => setAnalysisItems(r.analyses || []))
        .catch(() => setAnalysisItems([]))
        .finally(() => setLoadingList(false));
    } else {
      setLoadingList(true);
      api.listInterviews()
        .then((r) => setInterviewItems(r.interviews || []))
        .catch(() => setInterviewItems([]))
        .finally(() => setLoadingList(false));
    }
  }, [tab]);

  // 拉取分析详情
  useEffect(() => {
    if (!selectedAnalysisId) {
      setAnalysisDetail(null);
      return;
    }
    setLoadingAnalysis(true);
    api.getAnalysis(selectedAnalysisId)
      .then((r) => setAnalysisDetail(r))
      .catch(() => setAnalysisDetail(null))
      .finally(() => setLoadingAnalysis(false));
  }, [selectedAnalysisId]);

  // 拉取面试详情
  useEffect(() => {
    if (!selectedInterviewId) {
      setInterviewDetail(null);
      return;
    }
    setLoadingInterview(true);
    api.getInterviewReport(selectedInterviewId)
      .then((r) => setInterviewDetail(r))
      .catch(() => setInterviewDetail(null))
      .finally(() => setLoadingInterview(false));
  }, [selectedInterviewId]);

  return (
    <div className="flex h-screen flex-col">
      {/* 顶栏 */}
      <div
        className="shrink-0 px-6 pt-5 pb-3 border-b"
        style={{ borderColor: "var(--border)", background: "var(--bg-sidebar)" }}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[20px] font-semibold text-stone-800">历史记录</h1>
            <p className="text-[12px] text-stone-500 mt-0.5">
              查阅过往的面试分析报告与模拟面试记录
            </p>
          </div>
          <Link
            href={tab === "analysis" ? "/analysis" : "/interview"}
            className="btn btn-secondary"
          >
            {tab === "analysis" ? "去新建分析 →" : "去模拟面试 →"}
          </Link>
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          <TabButton
            active={tab === "analysis"}
            onClick={() => setTab("analysis")}
            label="面试分析"
            count={analysisItems.length}
          />
          <TabButton
            active={tab === "interview"}
            onClick={() => setTab("interview")}
            label="模拟面试"
            count={interviewItems.length}
          />
        </div>
      </div>

      {/* 主内容 */}
      <div className="flex-1 min-h-0 flex">
        {/* 左侧列表 */}
        <div
          className="w-[340px] shrink-0 flex flex-col border-r overflow-hidden"
          style={{ borderColor: "var(--border)", background: "var(--bg-sidebar)" }}
        >
          <div className="flex-1 overflow-y-auto p-3">
            {loadingList ? (
              <div className="p-8 text-center text-[13px] text-stone-400">加载中…</div>
            ) : tab === "analysis" ? (
              analysisItems.length === 0 ? (
                <EmptyHint text="还没有分析报告" href="/analysis" cta="去生成第一份报告 →" />
              ) : (
                analysisItems.map((it) => (
                <AnalysisListCard
                  key={it.id}
                  item={it}
                  active={selectedAnalysisId === it.id}
                  onClick={() => setSelectedAnalysisId(it.id)}
                  onDelete={() =>
                    setPendingDelete({
                      type: "analysis",
                      id: it.id,
                      title: `${it.company_name || "未指定公司"} · ${it.job_title || "未指定岗位"}`,
                    })
                  }
                />
              ))
              )
            ) : interviewItems.length === 0 ? (
              <EmptyHint text="还没有模拟面试记录" href="/interview" cta="去开启一场面试 →" />
            ) : (
              interviewItems.map((it) => (
                <InterviewListCard
                  key={it.id}
                  item={it}
                  active={selectedInterviewId === it.id}
                  onClick={() => setSelectedInterviewId(it.id)}
                  onDelete={() =>
                    setPendingDelete({
                      type: "interview",
                      id: it.id,
                      title: `${it.company_name || "未指定公司"} · ${it.job_title || "未指定岗位"}`,
                    })
                  }
                />
              ))
            )}
          </div>
        </div>

        {/* 右侧详情 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {tab === "analysis" ? (
            selectedAnalysisId ? (
              loadingAnalysis ? (
                <CenterSpinner text="加载报告中…" />
              ) : analysisDetail ? (
                analysisDetail.result ? (
                  <AnalysisReportView detail={analysisDetail} />
                ) : analysisDetail.status === "error" ? (
                  <CenterHint text={analysisDetail.error || "分析失败"} />
                ) : analysisDetail.status === "cancelled" ? (
                  <CenterHint text={analysisDetail.error || "该分析已被取消"} />
                ) : (
                  <CenterSpinner text="分析进行中…" />
                )
              ) : (
                <CenterHint text="加载失败,请重试" />
              )
            ) : (
              <CenterHint text="从左侧选择一条记录查看完整报告" />
            )
          ) : selectedInterviewId ? (
            loadingInterview ? (
              <CenterSpinner text="加载面试记录…" />
            ) : interviewDetail ? (
              <InterviewReportView detail={interviewDetail} />
            ) : (
              <CenterHint text="加载失败,请重试" />
            )
          ) : (
            <CenterHint text="从左侧选择一条记录查看完整面试回放" />
          )}
        </div>
      </div>

      {/* 删除确认弹窗 */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(28, 25, 23, 0.4)" }}
          onClick={() => {
            if (!deleting) {
              setPendingDelete(null);
              setDeleteError("");
            }
          }}
        >
          <div
            className="w-[400px] rounded-xl shadow-xl p-6"
            style={{ background: "var(--bg-elevated)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[16px] font-semibold text-stone-800 mb-2">确认删除</h3>
            <p className="text-[13px] text-stone-600 leading-relaxed mb-1">
              确定要删除这条{pendingDelete.type === "analysis" ? "面试分析" : "模拟面试"}记录吗?
            </p>
            <p className="text-[12px] text-stone-400 truncate mb-3">{pendingDelete.title}</p>
            <p className="text-[11px] text-stone-400 mb-3">
              删除后后端对应的 JSON 文件也会一并删除,操作不可恢复。
            </p>
            {deleteError && (
              <p
                className="text-[11px] mb-3 px-2 py-1.5 rounded"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {deleteError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setPendingDelete(null);
                  setDeleteError("");
                }}
                disabled={deleting}
                className="btn btn-secondary"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="btn btn-primary"
                style={{ background: "var(--danger)" }}
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 通用小组件 ──

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
        active ? "text-stone-900" : "text-stone-500 hover:text-stone-800"
      }`}
      style={{
        background: active ? "var(--bg-elevated)" : "transparent",
        boxShadow: active ? "0 1px 3px -1px rgb(28 25 23 / 0.08)" : "none",
      }}
    >
      {label}
      {count > 0 && (
        <span
          className="ml-1.5 px-1.5 py-0.5 rounded text-[10px]"
          style={{
            background: active ? "var(--accent-bg)" : "var(--bg-muted)",
            color: active ? "var(--accent)" : "var(--fg-muted)",
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function EmptyHint({ text, href, cta }: { text: string; href: string; cta: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <svg
        className="w-10 h-10 mx-auto mb-3 text-stone-300"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <div className="text-[13px] text-stone-400 mb-2">{text}</div>
      <Link href={href} className="text-[12px] text-orange-700 hover:underline">
        {cta}
      </Link>
    </div>
  );
}

function CenterHint({ text }: { text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-stone-400">
      <svg
        className="w-12 h-12 mb-3 opacity-40"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <div className="text-[14px]">{text}</div>
    </div>
  );
}

function CenterSpinner({ text }: { text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-stone-500">
      <div className="w-10 h-10 rounded-full border-2 border-orange-200 border-t-orange-600 animate-spin mb-3" />
      <div className="text-[14px]">{text}</div>
    </div>
  );
}

// ── 分析列表卡片 ──

function AnalysisListCard({
  item,
  active,
  onClick,
  onDelete,
}: {
  item: AnalysisSummary;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const score = item.match_score || 0;
  const sc = scoreColor(score);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";
  const isPending = item.status === "pending";
  const isError = item.status === "error";
  const isCancelled = item.status === "cancelled";

  return (
    <div
      onClick={onClick}
      className="group w-full text-left p-3 rounded-lg mb-2 transition-all cursor-pointer relative"
      style={{
        background: active ? "var(--bg-elevated)" : "transparent",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
      }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-stone-400 hover:text-red-500 px-1.5 py-0.5 rounded"
        title="删除该记录"
      >
        删除
      </button>
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-lg shrink-0 flex flex-col items-center justify-center"
          style={{ background: "var(--bg-muted)", color: isError ? "var(--danger)" : scColor }}
        >
          {isPending ? (
            <span className="text-[9px] font-medium">进行中</span>
          ) : isError ? (
            <span className="text-[9px] font-medium">失败</span>
          ) : isCancelled ? (
            <span className="text-[9px] font-medium">已取消</span>
          ) : (
            <>
              <span className="text-[14px] font-bold leading-none">{score}</span>
              <span className="text-[8px] mt-0.5 opacity-70">分</span>
            </>
          )}
        </div>
        <div className="flex-1 min-w-0 pr-12">
          <div className="text-[13px] font-medium text-stone-800 truncate">
            {item.company_name || item.title || "未指定公司"} · {item.job_title || "未指定岗位"}
          </div>
          <div className="text-[11px] text-stone-400 mt-0.5 flex items-center gap-2">
            {isPending ? (
              <span>分析进行中…</span>
            ) : (
              <span>{item.rounds_count} 轮题</span>
            )}
            <span>·</span>
            <span>{relativeTime(item.created_at)}</span>
          </div>
          {/* analysis_id:供复制粘贴到模拟面试页 */}
          <div
            className="text-[10px] mt-1 font-mono text-stone-400 truncate select-all"
            title={`分析 ID:${item.id}(可复制粘贴到模拟面试页)`}
          >
            {item.id}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 面试列表卡片 ──

function InterviewListCard({
  item,
  active,
  onClick,
  onDelete,
}: {
  item: InterviewListItem;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const finished = item.status === "finished";
  const abandoned = item.status === "abandoned";
  const score = item.overall_score || 0;
  const sc = scoreColor(score);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div
      onClick={onClick}
      className="group w-full text-left p-3 rounded-lg mb-2 transition-all cursor-pointer relative"
      style={{
        background: active ? "var(--bg-elevated)" : "transparent",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
      }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-stone-400 hover:text-red-500 px-1.5 py-0.5 rounded"
        title="删除该记录"
      >
        删除
      </button>
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-lg shrink-0 flex flex-col items-center justify-center"
          style={{
            background: finished ? "var(--bg-muted)" : "var(--accent-bg)",
            color: finished ? scColor : "var(--accent)",
          }}
        >
          {finished ? (
            <>
              <span className="text-[14px] font-bold leading-none">{score}</span>
              <span className="text-[8px] mt-0.5 opacity-70">分</span>
            </>
          ) : abandoned ? (
            <span className="text-[9px] font-medium" style={{ color: "var(--fg-muted)" }}>已放弃</span>
          ) : (
            <span className="text-[10px] font-semibold">进行中</span>
          )}
        </div>
        <div className="flex-1 min-w-0 pr-12">
          <div className="text-[13px] font-medium text-stone-800 truncate">
            {item.company_name || "未指定公司"} · {item.job_title || "未指定岗位"}
          </div>
          <div className="text-[11px] text-stone-400 mt-0.5 flex items-center gap-2">
            <span>{item.turns} 轮问答</span>
            <span>·</span>
            <span>{relativeTime(item.created_at)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 分析报告详情 ──

function AnalysisReportView({ detail }: { detail: AnalysisDetail }) {
  const [fullscreen, setFullscreen] = useState(false);
  const result: InterviewResult = detail.result!;
  const title = `${result.company_name || "未指定公司"} · ${result.job_title || "未指定岗位"}`;
  const subtitle = `面试分析报告 · 生成于 ${formatDate(detail.created_at)}`;

  return (
    <>
      <div className="max-w-[960px] mx-auto p-8 fade-in">
        {/* 报告头 */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold text-stone-800 mb-1">
              {result.company_name || "未指定公司"} · {result.job_title || "未指定岗位"}
            </h1>
            <div className="text-[12px] text-stone-400">
              面试分析报告 · 生成于 {formatDate(detail.created_at)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <FullscreenButton onClick={() => setFullscreen(true)} />
            <Link
              href={`/interview?analysis=${detail.analysis_id}`}
              className="btn btn-primary"
            >
              基于此报告模拟面试 →
            </Link>
          </div>
        </div>

        <AnalysisReportBody result={result} />
      </div>

      {/* 全屏预览 */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={title}
        subtitle={`${subtitle} · 按 Esc 退出`}
        maxWidth={960}
      >
        <AnalysisReportBody result={result} />
      </FullscreenPreview>
    </>
  );
}

// ── 分析报告主体(内联与全屏共用) ──
function AnalysisReportBody({ result }: { result: InterviewResult }) {
  const score = result.match_analysis.match_score || 0;
  const sc = scoreColor(score);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";
  const levelText =
    score >= 80 ? "高度匹配" : score >= 60 ? "基本匹配" : score >= 40 ? "勉强匹配" : "差距较大";

  return (
    <>
      {/* 匹配度 */}
      <div className="card p-6 mb-6" style={{ background: "var(--bg-elevated)" }}>
        <div className="flex items-center gap-6">
          <div className="relative w-24 h-24 shrink-0">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="8" />
              <circle
                cx="48"
                cy="48"
                r="42"
                fill="none"
                stroke={scColor}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${(score / 100) * 264} 264`}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[26px] font-bold" style={{ color: scColor }}>
                {score}
              </div>
              <div className="text-[10px] text-stone-400">/ 100</div>
            </div>
          </div>
          <div className="flex-1">
            <div className="text-[16px] font-semibold text-stone-800 mb-1">{levelText}</div>
            <div className="text-[12px] text-stone-500 leading-relaxed">
              综合评估简历与岗位 JD 的匹配程度。
            </div>
          </div>
        </div>
      </div>

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

      {/* 匹配详情 */}
      <Section title="匹配详情" icon="🔍">
        <div className="grid grid-cols-3 gap-3">
          <PointsCard title="强匹配" items={result.match_analysis.strong_points} variant="success" />
          <PointsCard title="需补强" items={result.match_analysis.weak_points} variant="warning" />
          <PointsCard title="未提及" items={result.match_analysis.not_mentioned} variant="danger" />
        </div>
      </Section>

      {/* 面试题 */}
      {result.questions.rounds.length > 0 && (
        <Section title={`面试题推演(${result.questions.rounds.length} 轮)`} icon="❓">
          <div className="space-y-3">
            {result.questions.rounds.map((round, i) => (
              <HistoryRoundCard key={i} round={round} roundIndex={i} />
            ))}
          </div>
        </Section>
      )}

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

// ── 历史中的面试题卡片(默认展开第一题)──

function HistoryRoundCard({ round, roundIndex }: { round: InterviewRound; roundIndex: number }) {
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
          <HistoryQuestionItem
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

function HistoryQuestionItem({
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
          {q.focus && <DetailItem label="考察点" content={q.focus} variant="muted" />}
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

// ── 模拟面试报告详情 ──

function InterviewReportView({ detail }: { detail: InterviewReportDetail }) {
  const [fullscreen, setFullscreen] = useState(false);
  const report = detail.report;
  const finished = detail.status === "finished" && !!report;
  const abandoned = detail.status === "abandoned";
  const statusText = finished ? "已完成" : abandoned ? "已放弃" : "进行中";
  const title = `${detail.company_name || "未指定公司"} · ${detail.job_title || "未指定岗位"}`;
  const subtitle = `模拟面试记录 · ${detail.turns.length} 轮问答 · ${statusText}${report?.created_at ? ` · ${formatDate(report.created_at)}` : ""}`;

  return (
    <>
      <div className="max-w-[900px] mx-auto p-8 fade-in">
        {/* 报告头 */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold text-stone-800 mb-1">
              {detail.company_name || "未指定公司"} · {detail.job_title || "未指定岗位"}
            </h1>
            <div className="text-[12px] text-stone-400">
              模拟面试记录 · {detail.turns.length} 轮问答 · {statusText}
              {report?.created_at && ` · ${formatDate(report.created_at)}`}
            </div>
          </div>
          <FullscreenButton onClick={() => setFullscreen(true)} />
        </div>

        <InterviewReportBody detail={detail} />
      </div>

      {/* 全屏预览 */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={title}
        subtitle={`${subtitle} · 按 Esc 退出`}
        maxWidth={900}
      >
        <InterviewReportBody detail={detail} />
      </FullscreenPreview>
    </>
  );
}

// ── 模拟面试报告主体(内联与全屏共用) ──
function InterviewReportBody({ detail }: { detail: InterviewReportDetail }) {
  const report = detail.report;
  const finished = detail.status === "finished" && !!report;
  const abandoned = detail.status === "abandoned";
  const score = report?.overall_score || 0;
  const sc = scoreColor(score);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <>
      {!finished ? (
        <div
          className="card p-6 mb-6 text-center"
          style={
            abandoned
              ? { background: "var(--bg-muted)", color: "var(--fg-muted)" }
              : { background: "var(--accent-bg)", color: "var(--accent)" }
          }
        >
          <div className="text-[14px] font-semibold mb-1">
            {abandoned ? "该面试已放弃" : "该面试尚未完成"}
          </div>
          <div className="text-[12px] opacity-80">
            {abandoned
              ? `已进行 ${detail.turns.length} 轮后放弃,未生成最终报告`
              : `已进行 ${detail.turns.length} 轮,可前往面试页继续或结束生成报告`}
          </div>
          {!abandoned && (
            <Link href="/interview" className="btn btn-primary mt-3 inline-block">
              去继续面试 →
            </Link>
          )}
        </div>
      ) : (
        <>
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
                  {report!.summary.split("\n")[0] || "综合评估"}
                </div>
                <div className="text-[12px] text-stone-500">
                  完成 {report!.rounds_completed} 轮 · {report!.company_name} · {report!.job_title}
                </div>
              </div>
            </div>
          </div>

          {/* 总评 */}
          {report!.summary && (
            <div className="card p-4 mb-4">
              <div className="text-[11px] font-semibold text-stone-500 mb-1.5">总评</div>
              <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
                {report!.summary}
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
              {report!.strengths.length === 0 ? (
                <div className="text-[12px] text-stone-400">—</div>
              ) : (
                <ul className="space-y-1">
                  {report!.strengths.map((s, i) => (
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
              {report!.weak_areas.length === 0 ? (
                <div className="text-[12px] text-stone-400">—</div>
              ) : (
                <ul className="space-y-1">
                  {report!.weak_areas.map((s, i) => (
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
          {report!.learning_suggestions.length > 0 && (
            <div className="card p-4 mb-6">
              <div
                className="text-[12px] font-semibold mb-2 flex items-center gap-1.5"
                style={{ color: "var(--accent)" }}
              >
                <span>📚</span> 学习建议
              </div>
              <ul className="space-y-1.5">
                {report!.learning_suggestions.map((s, i) => (
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
        </>
      )}

      {/* 完整问答回放 */}
      {detail.turns.length > 0 && (
        <Section title={`问答回放(${detail.turns.length} 轮)`} icon="💬">
          <div className="space-y-3">
            {detail.turns.map((t, i) => (
              <TurnReplay key={i} turn={t} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function TurnReplay({ turn }: { turn: InterviewTurn }) {
  const sc = scoreColor(turn.score, 10);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div className="card overflow-hidden">
      {/* 问题 */}
      <div
        className="px-4 py-3"
        style={{ background: "var(--accent-bg)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-bold text-white px-1.5 py-0.5 rounded" style={{ background: "var(--accent)" }}>
            Q{turn.turn_index}
          </span>
          {turn.evaluated && (
            <span
              className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
              style={{ background: "var(--bg-muted)", color: scColor }}
            >
              {turn.score}/10
            </span>
          )}
        </div>
        <div className="text-[13px] text-stone-800 leading-relaxed">{turn.question}</div>
      </div>

      {/* 回答 */}
      {turn.answer ? (
        <div className="px-4 py-3" style={{ background: "var(--bg-elevated)" }}>
          <div className="text-[11px] text-stone-500 font-semibold mb-1">你的回答</div>
          <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
            {turn.answer}
          </div>
        </div>
      ) : (
        <div className="px-4 py-3 text-[12px] text-stone-400" style={{ background: "var(--bg-elevated)" }}>
          （未作答）
        </div>
      )}

      {/* 评价 */}
      {turn.evaluated && turn.evaluation && (
        <div
          className="px-4 py-3"
          style={{ background: "var(--bg-muted)", borderTop: "1px solid var(--border)" }}
        >
          <div className="text-[11px] font-semibold mb-1" style={{ color: scColor }}>
            AI 评价
          </div>
          <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
            {turn.evaluation}
          </div>
          {turn.improvements && turn.improvements.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] text-stone-500 font-semibold mb-1">改进建议</div>
              <ul className="space-y-1">
                {turn.improvements.map((imp, i) => (
                  <li key={i} className="text-[12px] text-stone-700 flex gap-1.5">
                    <span className="text-orange-600">•</span>
                    <span>{imp}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
