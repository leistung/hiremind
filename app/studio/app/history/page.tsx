"use client"; // 客户端组件:需要访问浏览器 API 与路由参数

// 引入 React hooks、Next.js 路由能力与 API 客户端
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
// 工具函数:日期格式化 / 相对时间 / 评分配色
import { formatDate, relativeTime, scoreColor } from "@/lib/utils";
// 全屏预览组件
import FullscreenPreview, { FullscreenButton } from "@/components/FullscreenPreview";
// 引入历史记录相关类型
import type {
  AnalysisDetail, // 分析详情
  AnalysisSummary, // 分析记录摘要
  InterviewListItem, // 面试列表项
  InterviewReportDetail, // 面试报告详情
  InterviewResult, // 分析结果
  InterviewRound, // 面试轮次
  InterviewTurn, // 单轮问答
  Question, // 面试题
} from "@/lib/types";

/** 历史记录页的两种 Tab 类型。 */
type Tab = "analysis" | "interview";

/**
 * 来源跳转链接:展示关联的简历/职位/分析 ID,点击跳转到对应页面。
 * @param label - 链接标签(如"简历"/"职位"/"来源分析")
 * @param value - 展示的 ID 或名称
 * @param href - 跳转目标 URL
 * @param onJump - 可选,点击时额外执行的回调(如阻止冒泡)
 */
function SourceLink({
  label,
  value,
  href,
  onJump,
}: {
  label: string;
  value: string;
  href: string;
  onJump?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      {/* 标签(灰字) */}
      <span className="text-stone-400">{label}:</span>
      {/* 跳转链接:等宽字体,超长截断,hover 变橙下划线 */}
      <Link
        href={href}
        onClick={onJump}
        className="font-mono text-stone-500 hover:text-orange-700 hover:underline truncate max-w-[280px]"
        title={`点击查看: ${value}`} // 悬浮显示完整值
      >
        {value}
      </Link>
    </div>
  );
}

/**
 * 页面包装组件:用 Suspense 包裹。
 * useSearchParams 在 App Router 中需要 Suspense 边界,否则构建报错。
 */
export default function HistoryPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <HistoryPage />
    </Suspense>
  );
}

/**
 * 历史记录页面:双 Tab(面试分析 / 模拟面试)统一归档。
 *
 * 布局:顶栏(Tab 切换)→ 左侧列表卡片 → 右侧详情。
 * 功能:
 * - 跨 Tab 跳转:?tab=analysis&aid=xxx 或 ?tab=interview&iid=xxx
 * - 记录删除(带确认弹窗,前后端同步删除)
 * - 溯源跳转:分析记录可跳到关联简历/职位,面试记录可跳到来源分析
 * - 报告详情支持全屏预览
 */
function HistoryPage() {
  const searchParams = useSearchParams(); // 读取 URL 查询参数
  const router = useRouter(); // 路由操作(切换 Tab 时更新 URL)
  const [tab, setTab] = useState<Tab>("analysis"); // 当前 Tab

  /**
   * 切换 Tab:同时更新 URL,清除旧的 aid/iid 参数,
   * 否则再次点击相同 aid 的跳转链接时 Next.js 认为是相同 URL 不导航。
   */
  function switchTab(next: Tab) {
    setTab(next); // 更新 Tab 状态
    router.replace(`/history?tab=${next}`); // 替换 URL(仅保留 tab 参数)
  }

  // ── 面试分析历史状态 ──
  const [analysisItems, setAnalysisItems] = useState<AnalysisSummary[]>([]); // 分析列表
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(""); // 选中的分析 ID
  const [analysisDetail, setAnalysisDetail] = useState<AnalysisDetail | null>(null); // 分析详情
  const [loadingAnalysis, setLoadingAnalysis] = useState(false); // 详情加载中

  // ── 模拟面试历史状态 ──
  const [interviewItems, setInterviewItems] = useState<InterviewListItem[]>([]); // 面试列表
  const [selectedInterviewId, setSelectedInterviewId] = useState(""); // 选中的面试 ID
  const [interviewDetail, setInterviewDetail] = useState<InterviewReportDetail | null>(null); // 面试详情
  const [loadingInterview, setLoadingInterview] = useState(false); // 详情加载中

  const [loadingList, setLoadingList] = useState(false); // 列表加载中
  // 待删除项(用于确认弹窗)
  const [pendingDelete, setPendingDelete] = useState<{ type: Tab; id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false); // 删除中
  const [deleteError, setDeleteError] = useState(""); // 删除错误信息

  /** 执行删除:按类型调用对应接口,删除后清除选中并刷新列表。 */
  async function handleDelete() {
    if (!pendingDelete) return; // 无待删项则忽略
    setDeleting(true); // 进入删除态
    setDeleteError(""); // 清空错误
    try {
      if (pendingDelete.type === "analysis") {
        // 删除分析记录
        await api.deleteAnalysis(pendingDelete.id);
        // 清除选中状态(若删除的是当前选中项)
        if (selectedAnalysisId === pendingDelete.id) {
          setSelectedAnalysisId("");
          setAnalysisDetail(null);
        }
        // 刷新列表
        const r = await api.listAnalyses();
        setAnalysisItems(r.analyses || []);
      } else {
        // 删除面试记录
        await api.deleteInterview(pendingDelete.id);
        if (selectedInterviewId === pendingDelete.id) {
          setSelectedInterviewId("");
          setInterviewDetail(null);
        }
        const r = await api.listInterviews();
        setInterviewItems(r.interviews || []);
      }
      setPendingDelete(null); // 关闭弹窗
    } catch (err) {
      // 删除失败时保留弹窗,显示错误,让用户重试或取消
      setDeleteError(
        err instanceof Error ? err.message : "删除失败,请检查后端服务后重试"
      );
    } finally {
      setDeleting(false); // 无论成败退出删除态
    }
  }

  // ── 拉取列表:切换 Tab 时加载对应类型的历史记录 ──
  useEffect(() => {
    if (tab === "analysis") {
      setLoadingList(true); // 进入加载态
      api.listAnalyses()
        .then((r) => setAnalysisItems(r.analyses || []))
        .catch(() => setAnalysisItems([])) // 失败置空
        .finally(() => setLoadingList(false));
    } else {
      setLoadingList(true);
      api.listInterviews()
        .then((r) => setInterviewItems(r.interviews || []))
        .catch(() => setInterviewItems([]))
        .finally(() => setLoadingList(false));
    }
  }, [tab]); // 依赖 Tab

  // ── 拉取分析详情:选中项变化时加载 ──
  useEffect(() => {
    if (!selectedAnalysisId) {
      setAnalysisDetail(null); // 无选中则清空
      return;
    }
    setLoadingAnalysis(true); // 进入加载态
    api.getAnalysis(selectedAnalysisId)
      .then((r) => setAnalysisDetail(r))
      .catch(() => setAnalysisDetail(null)) // 失败置空
      .finally(() => setLoadingAnalysis(false));
  }, [selectedAnalysisId]); // 依赖选中项

  // ── 拉取面试详情:选中项变化时加载 ──
  useEffect(() => {
    if (!selectedInterviewId) {
      setInterviewDetail(null); // 无选中则清空
      return;
    }
    setLoadingInterview(true);
    api.getInterviewReport(selectedInterviewId)
      .then((r) => setInterviewDetail(r))
      .catch(() => setInterviewDetail(null))
      .finally(() => setLoadingInterview(false));
  }, [selectedInterviewId]);

  // ── 处理跨 tab 跳转:?tab=analysis&aid=xxx 或 ?tab=interview&iid=xxx ──
  useEffect(() => {
    const targetTab = searchParams.get("tab") as Tab | null; // 目标 Tab
    const aid = searchParams.get("aid"); // 分析 ID 参数
    const iid = searchParams.get("iid"); // 面试 ID 参数
    if (targetTab === "analysis" && aid) {
      setTab("analysis"); // 切换到分析 Tab
      setSelectedAnalysisId(aid); // 选中目标分析
    } else if (targetTab === "interview" && iid) {
      setTab("interview"); // 切换到面试 Tab
      setSelectedInterviewId(iid); // 选中目标面试
    }
  }, [searchParams]); // 依赖 URL 参数

  return (
    // 页面布局:纵向 flex,高度铺满视口
    <div className="flex h-screen flex-col">
      {/* ═══ 顶栏 ═══ */}
      <div
        className="shrink-0 px-6 pt-5 pb-3 border-b"
        style={{ borderColor: "var(--border)", background: "var(--bg-sidebar)" }}
      >
        {/* 标题行:标题 + 快捷跳转按钮 */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[20px] font-semibold text-stone-800">历史记录</h1>
            <p className="text-[12px] text-stone-500 mt-0.5">
              查阅过往的面试分析报告与模拟面试记录
            </p>
          </div>
          {/* 按当前 Tab 跳转到对应功能页 */}
          <Link
            href={tab === "analysis" ? "/analysis" : "/interview"}
            className="btn btn-secondary"
          >
            {tab === "analysis" ? "去新建分析 →" : "去模拟面试 →"}
          </Link>
        </div>

        {/* Tab 切换:面试分析 / 模拟面试(带数量徽章) */}
        <div className="flex gap-1">
          <TabButton
            active={tab === "analysis"}
            onClick={() => switchTab("analysis")}
            label="面试分析"
            count={analysisItems.length}
          />
          <TabButton
            active={tab === "interview"}
            onClick={() => switchTab("interview")}
            label="模拟面试"
            count={interviewItems.length}
          />
        </div>
      </div>

      {/* ═══ 主内容区:左列表 + 右详情 ═══ */}
      <div className="flex-1 min-h-0 flex">
        {/* ── 左侧:记录列表 ── */}
        <div
          className="w-[340px] shrink-0 flex flex-col border-r overflow-hidden"
          style={{ borderColor: "var(--border)", background: "var(--bg-sidebar)" }}
        >
          <div className="flex-1 overflow-y-auto p-3">
            {loadingList ? (
              // 列表加载中
              <div className="p-8 text-center text-[13px] text-stone-400">加载中…</div>
            ) : tab === "analysis" ? (
              // ── 分析 Tab ──
              analysisItems.length === 0 ? (
                // 空态:引导去分析
                <EmptyHint text="还没有分析报告" href="/analysis" cta="去生成第一份报告 →" />
              ) : (
                // 分析卡片列表
                analysisItems.map((it) => (
                <AnalysisListCard
                  key={it.id}
                  item={it}
                  active={selectedAnalysisId === it.id} // 是否选中
                  onClick={() => setSelectedAnalysisId(it.id)} // 点击选中
                  onDelete={() =>
                    setPendingDelete({
                      type: "analysis", // 删除类型
                      id: it.id, // 记录 ID
                      title: `${it.company_name || "未指定公司"} · ${it.job_title || "未指定岗位"}`, // 弹窗标题
                    })
                  }
                />
              ))
              )
            ) : interviewItems.length === 0 ? ( // ── 面试 Tab:空态 → 引导去面试 ──
              <EmptyHint text="还没有模拟面试记录" href="/interview" cta="去开启一场面试 →" />
            ) : (
              // 面试卡片列表
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

        {/* ── 右侧:详情区 ── */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {tab === "analysis" ? (
            // ── 分析详情分支 ──
            selectedAnalysisId ? (
              loadingAnalysis ? (
                <CenterSpinner text="加载报告中…" /> // 加载中
              ) : analysisDetail ? (
                analysisDetail.result ? (
                  <AnalysisReportView detail={analysisDetail} /> // 有结果:渲染报告
                ) : analysisDetail.status === "error" ? (
                  <CenterHint text={analysisDetail.error || "分析失败"} /> // 出错
                ) : analysisDetail.status === "cancelled" ? (
                  <CenterHint text={analysisDetail.error || "该分析已被取消"} /> // 已取消
                ) : (
                  <CenterSpinner text="分析进行中…" /> // 仍在分析
                )
              ) : (
                <CenterHint text="加载失败,请重试" /> // 详情加载失败
              )
            ) : (
              <CenterHint text="从左侧选择一条记录查看完整报告" /> // 未选中
            )
          ) : selectedInterviewId ? ( // ── 面试详情分支:加载中/有详情/失败 ──
            loadingInterview ? (
              <CenterSpinner text="加载面试记录…" /> // 加载中
            ) : interviewDetail ? (
              <InterviewReportView detail={interviewDetail} /> // 有详情:渲染报告
            ) : (
              <CenterHint text="加载失败,请重试" /> // 加载失败
            )
          ) : (
            <CenterHint text="从左侧选择一条记录查看完整面试回放" /> // 未选中
          )}
        </div>
      </div>

      {/* ═══ 删除确认弹窗 ═══ */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(28, 25, 23, 0.4)" }} // 半透明遮罩
          onClick={() => {
            // 点击遮罩关闭(删除进行中不可关闭)
            if (!deleting) {
              setPendingDelete(null);
              setDeleteError("");
            }
          }}
        >
          {/* 弹窗主体:stopPropagation 防止点击内部触发遮罩关闭 */}
          <div
            className="w-[400px] rounded-xl shadow-xl p-6"
            style={{ background: "var(--bg-elevated)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹窗标题 */}
            <h3 className="text-[16px] font-semibold text-stone-800 mb-2">确认删除</h3>
            {/* 提示文案 */}
            <p className="text-[13px] text-stone-600 leading-relaxed mb-1">
              确定要删除这条{pendingDelete.type === "analysis" ? "面试分析" : "模拟面试"}记录吗?
            </p>
            {/* 被删记录标题 */}
            <p className="text-[12px] text-stone-400 truncate mb-3">{pendingDelete.title}</p>
            {/* 不可恢复提示 */}
            <p className="text-[11px] text-stone-400 mb-3">
              删除后后端对应的 JSON 文件也会一并删除,操作不可恢复。
            </p>
            {/* 删除错误提示(红底) */}
            {deleteError && (
              <p
                className="text-[11px] mb-3 px-2 py-1.5 rounded"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {deleteError}
              </p>
            )}
            {/* 操作按钮:取消 / 确认删除 */}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setPendingDelete(null); // 关闭弹窗
                  setDeleteError(""); // 清空错误
                }}
                disabled={deleting} // 删除中禁用
                className="btn btn-secondary"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="btn btn-primary"
                style={{ background: "var(--danger)" }} // 红色主按钮
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

// ═══════════════════════ 通用小组件 ═══════════════════════

/**
 * Tab 切换按钮:展示标签与数量徽章。
 * @param active - 是否激活
 * @param onClick - 点击回调
 * @param label - 按钮文字
 * @param count - 记录数量(>0 时显示徽章)
 */
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
        // 激活项:白底 + 轻阴影
        background: active ? "var(--bg-elevated)" : "transparent",
        boxShadow: active ? "0 1px 3px -1px rgb(28 25 23 / 0.08)" : "none",
      }}
    >
      {label}
      {/* 数量徽章(仅 count > 0 时显示) */}
      {count > 0 && (
        <span
          className="ml-1.5 px-1.5 py-0.5 rounded text-[10px]"
          style={{
            // 激活:橙底橙字;未激活:灰底灰字
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

/** 列表空态提示:图标 + 文案 + 跳转链接。 */
function EmptyHint({ text, href, cta }: { text: string; href: string; cta: string }) {
  return (
    <div className="px-4 py-10 text-center">
      {/* 空态图标(文档轮廓) */}
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
      {/* 文案 */}
      <div className="text-[13px] text-stone-400 mb-2">{text}</div>
      {/* 跳转 CTA */}
      <Link href={href} className="text-[12px] text-orange-700 hover:underline">
        {cta}
      </Link>
    </div>
  );
}

/** 居中提示:垂直居中的图标 + 文案(用于详情区空态/错误)。 */
function CenterHint({ text }: { text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-stone-400">
      {/* 时钟图标(半透明) */}
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

/** 居中加载动画:橙色旋转圆圈 + 文案。 */
function CenterSpinner({ text }: { text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-stone-500">
      {/* 旋转圆圈:橙色半弧 */}
      <div className="w-10 h-10 rounded-full border-2 border-orange-200 border-t-orange-600 animate-spin mb-3" />
      <div className="text-[14px]">{text}</div>
    </div>
  );
}

// ═══════════════════════ 分析列表卡片 ═══════════════════════

/**
 * 分析记录列表卡片。
 * 展示:评分徽章(或状态)、公司·岗位、轮数、相对时间、可复制的分析 ID。
 * hover 时显示删除按钮。
 */
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
  const score = item.match_score || 0; // 匹配度评分
  const sc = scoreColor(score); // 语义化颜色等级
  const scColor = // 颜色映射为 CSS 变量
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";
  const isPending = item.status === "pending"; // 分析中
  const isError = item.status === "error"; // 失败
  const isCancelled = item.status === "cancelled"; // 已取消

  return (
    <div
      onClick={onClick} // 点击选中
      className="group w-full text-left p-3 rounded-lg mb-2 transition-all cursor-pointer relative"
      style={{
        // 选中项:白底 + 橙色描边
        background: active ? "var(--bg-elevated)" : "transparent",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
      }}
    >
      {/* hover 时显示的删除按钮(右上角) */}
      <button
        onClick={(e) => {
          e.stopPropagation(); // 阻止冒泡,避免触发选中
          onDelete(); // 触发删除确认
        }}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-stone-400 hover:text-red-500 px-1.5 py-0.5 rounded"
        title="删除该记录"
      >
        删除
      </button>
      <div className="flex items-start gap-3">
        {/* 评分/状态徽章块 */}
        <div
          className="w-10 h-10 rounded-lg shrink-0 flex flex-col items-center justify-center"
          style={{ background: "var(--bg-muted)", color: isError ? "var(--danger)" : scColor }}
        >
          {/* 按状态显示:进行中/失败/已取消/分数 */}
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
          {/* 公司 · 岗位 */}
          <div className="text-[13px] font-medium text-stone-800 truncate">
            {item.company_name || item.title || "未指定公司"} · {item.job_title || "未指定岗位"}
          </div>
          {/* 元信息行:轮数 + 相对时间 */}
          <div className="text-[11px] text-stone-400 mt-0.5 flex items-center gap-2">
            {isPending ? (
              <span>分析进行中…</span>
            ) : (
              <span>{item.rounds_count} 轮题</span>
            )}
            <span>·</span>
            <span>{relativeTime(item.created_at)}</span>
          </div>
          {/* analysis_id:供复制粘贴到模拟面试页(select-all 便于全选复制) */}
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

// ═══════════════════════ 面试列表卡片 ═══════════════════════

/**
 * 面试记录列表卡片。
 * 展示:分数/状态徽章、公司·岗位、轮数、相对时间、来源分析跳转。
 * hover 时显示删除按钮。
 */
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
  const finished = item.status === "finished"; // 是否已完成
  const abandoned = item.status === "abandoned"; // 是否已放弃
  const score = item.overall_score || 0; // 综合评分
  const sc = scoreColor(score);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div
      onClick={onClick} // 点击选中
      className="group w-full text-left p-3 rounded-lg mb-2 transition-all cursor-pointer relative"
      style={{
        background: active ? "var(--bg-elevated)" : "transparent",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
      }}
    >
      {/* hover 删除按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation(); // 阻止冒泡
          onDelete();
        }}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-stone-400 hover:text-red-500 px-1.5 py-0.5 rounded"
        title="删除该记录"
      >
        删除
      </button>
      <div className="flex items-start gap-3">
        {/* 分数/状态徽章块:进行中/已放弃用橙色系 */}
        <div
          className="w-10 h-10 rounded-lg shrink-0 flex flex-col items-center justify-center"
          style={{
            background: finished ? "var(--bg-muted)" : "var(--accent-bg)", // 完成:灰底;未完成:橙底
            color: finished ? scColor : "var(--accent)",
          }}
        >
          {finished ? (
            // 已完成:显示分数
            <>
              <span className="text-[14px] font-bold leading-none">{score}</span>
              <span className="text-[8px] mt-0.5 opacity-70">分</span>
            </>
          ) : abandoned ? (
            // 已放弃:灰字提示
            <span className="text-[9px] font-medium" style={{ color: "var(--fg-muted)" }}>已放弃</span>
          ) : (
            // 进行中:橙色提示
            <span className="text-[10px] font-semibold">进行中</span>
          )}
        </div>
        <div className="flex-1 min-w-0 pr-12">
          {/* 公司 · 岗位 */}
          <div className="text-[13px] font-medium text-stone-800 truncate">
            {item.company_name || "未指定公司"} · {item.job_title || "未指定岗位"}
          </div>
          {/* 元信息行:轮数 + 相对时间 */}
          <div className="text-[11px] text-stone-400 mt-0.5 flex items-center gap-2">
            <span>{item.turns} 轮问答</span>
            <span>·</span>
            <span>{relativeTime(item.created_at)}</span>
          </div>
          {/* 来源分析跳转(有 analysis_id 时显示) */}
          {item.analysis_id && (
            <Link
              href={`/history?tab=analysis&aid=${item.analysis_id}`} // 跳转到分析 Tab 并选中来源分析
              onClick={(e) => e.stopPropagation()} // 阻止冒泡,避免触发卡片选中
              className="inline-flex items-center gap-1 text-[10px] mt-1 font-mono text-stone-400 hover:text-orange-700 hover:underline"
              title={`来源分析 ID: ${item.analysis_id}(点击跳转查看)`}
            >
              {/* 外链图标 */}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              {item.analysis_id}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ 分析报告详情 ═══════════════════════

/**
 * 面试分析报告详情视图(内联展示 + 全屏预览)。
 * 头部:标题、生成时间、来源溯源(简历/职位)、全屏按钮、去模拟面试按钮。
 */
function AnalysisReportView({ detail }: { detail: AnalysisDetail }) {
  const [fullscreen, setFullscreen] = useState(false); // 全屏开关
  const result: InterviewResult = detail.result!; // 分析结果(调用方已保证非空)
  const title = `${result.company_name || "未指定公司"} · ${result.job_title || "未指定岗位"}`; // 标题
  const subtitle = `面试分析报告 · 生成于 ${formatDate(detail.created_at)}`; // 副标题
  // 从 metadata 提取简历/职位来源(用于溯源跳转)
  const meta = (detail.metadata || {}) as Record<string, string>;
  const resumeName = meta.resume_name || ""; // 简历名
  const positionName = meta.position_name || ""; // 职位名
  const resumeId = meta.resume_id || ""; // 简历 ID
  const positionId = meta.position_id || ""; // 职位 ID
  const hasMeta = Boolean(resumeName || positionName); // 是否有来源元数据

  return (
    <>
      {/* ── 内联详情 ── */}
      <div className="max-w-[960px] mx-auto p-8 fade-in">
        {/* 报告头 */}
        <div className="flex items-start justify-between mb-6">
          <div>
            {/* 主标题:公司 · 岗位 */}
            <h1 className="text-[22px] font-semibold text-stone-800 mb-1">
              {result.company_name || "未指定公司"} · {result.job_title || "未指定岗位"}
            </h1>
            {/* 副标题:报告类型 + 生成时间 */}
            <div className="text-[12px] text-stone-400">
              面试分析报告 · 生成于 {formatDate(detail.created_at)}
            </div>
            {/* 来源信息:简历 + 职位(有 metadata 时显示具体名称,否则显示通用入口) */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              {hasMeta ? (
                <>
                  {/* 简历溯源链接 */}
                  {resumeName && (
                    <SourceLink
                      label="简历"
                      value={resumeName}
                      href={resumeId ? `/resumes?resume=${resumeId}` : "/resumes"}
                    />
                  )}
                  {/* 职位溯源链接 */}
                  {positionName && (
                    <SourceLink
                      label="职位"
                      value={positionName}
                      href={positionId ? `/positions?position=${positionId}` : "/positions"}
                    />
                  )}
                </>
              ) : (
                <>
                  {/* 无元数据:显示通用入口 */}
                  <Link
                    href="/resumes"
                    className="text-[12px] text-stone-400 hover:text-orange-700 hover:underline"
                  >
                    查看简历库 →
                  </Link>
                  <Link
                    href="/positions"
                    className="text-[12px] text-stone-400 hover:text-orange-700 hover:underline"
                  >
                    查看职位库 →
                  </Link>
                </>
              )}
            </div>
          </div>
          {/* 右侧操作:全屏 + 去模拟面试 */}
          <div className="flex items-center gap-2">
            <FullscreenButton onClick={() => setFullscreen(true)} />
            <Link
              href={`/interview?analysis=${detail.analysis_id}`} // 携带分析 ID 启动面试
              className="btn btn-primary"
            >
              基于此报告模拟面试 →
            </Link>
          </div>
        </div>

        {/* 报告主体(内联与全屏共用) */}
        <AnalysisReportBody result={result} />
      </div>

      {/* ── 全屏预览 ── */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={title}
        subtitle={`${subtitle} · 按 Esc 退出`}
        maxWidth={960}
      >
        {/* 全屏内容:复用同一主体 */}
        <AnalysisReportBody result={result} />
      </FullscreenPreview>
    </>
  );
}

// ═══════════════════════ 分析报告主体(内联与全屏共用) ═══════════════════════

/**
 * 分析报告主体:匹配度评分环 + 改进点 + 匹配详情 + 面试题 + 业务场景 + 备考建议。
 * 内联与全屏预览共用,保证两处展示一致。
 */
function AnalysisReportBody({ result }: { result: InterviewResult }) {
  const score = result.match_analysis.match_score || 0; // 匹配度评分
  const sc = scoreColor(score); // 语义色等级
  const scColor = // 颜色映射
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";
  // 匹配度等级文案
  const levelText =
    score >= 80 ? "高度匹配" : score >= 60 ? "基本匹配" : score >= 40 ? "勉强匹配" : "差距较大";

  return (
    <>
      {/* ── 匹配度评分环 ── */}
      <div className="card p-6 mb-6" style={{ background: "var(--bg-elevated)" }}>
        <div className="flex items-center gap-6">
          {/* SVG 环形进度:底环(灰) + 进度环(语义色) */}
          <div className="relative w-24 h-24 shrink-0">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
              {/* 灰色底环 */}
              <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="8" />
              {/* 彩色进度环:strokeDasharray 按得分比例绘制 */}
              <circle
                cx="48"
                cy="48"
                r="42"
                fill="none"
                stroke={scColor}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${(score / 100) * 264} 264`} // 周长 ≈ 2π×42 ≈ 264
              />
            </svg>
            {/* 环中心:分数 + "/100" */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[26px] font-bold" style={{ color: scColor }}>
                {score}
              </div>
              <div className="text-[10px] text-stone-400">/ 100</div>
            </div>
          </div>
          {/* 等级文案区 */}
          <div className="flex-1">
            <div className="text-[16px] font-semibold text-stone-800 mb-1">{levelText}</div>
            <div className="text-[12px] text-stone-500 leading-relaxed">
              综合评估简历与岗位 JD 的匹配程度。
            </div>
          </div>
        </div>
      </div>

      {/* ── 改进点列表 ── */}
      {result.match_analysis.improvement_points.length > 0 && (
        <Section title="需要提升的改进点" icon="💡">
          <ul className="space-y-2">
            {/* 逐条:琥珀底提示卡片 */}
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

      {/* ── 匹配详情:强匹配 / 需补强 / 未提及 三列 ── */}
      <Section title="匹配详情" icon="🔍">
        <div className="grid grid-cols-3 gap-3">
          <PointsCard title="强匹配" items={result.match_analysis.strong_points} variant="success" />
          <PointsCard title="需补强" items={result.match_analysis.weak_points} variant="warning" />
          <PointsCard title="未提及" items={result.match_analysis.not_mentioned} variant="danger" />
        </div>
      </Section>

      {/* ── 面试题推演:按轮次渲染 ── */}
      {result.questions.rounds.length > 0 && (
        <Section title={`面试题推演(${result.questions.rounds.length} 轮)`} icon="❓">
          <div className="space-y-3">
            {result.questions.rounds.map((round, i) => (
              <HistoryRoundCard key={i} round={round} roundIndex={i} />
            ))}
          </div>
        </Section>
      )}

      {/* ── 业务场景推演 ── */}
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

      {/* ── 备考建议 ── */}
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
 * @param title - 卡片标题(如"强匹配")
 * @param items - 要点列表
 * @param variant - 语义色变体
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
  // 语义色映射表:背景 + 文字色
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
      {/* 空态:显示破折号 */}
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

// ═══════════════════════ 历史中的面试题卡片(默认展开第一题) ═══════════════════════

/**
 * 单轮面试题卡片:轮次标题栏 + 逐题折叠项。
 * 默认展开第一题(openIdx 初始为 0),点击标题切换展开/收起。
 */
function HistoryRoundCard({ round, roundIndex }: { round: InterviewRound; roundIndex: number }) {
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
          <HistoryQuestionItem
            key={i}
            q={q}
            index={i}
            open={openIdx === i} // 是否展开
            onToggle={() => setOpenIdx(openIdx === i ? null : i)} // 点击切换展开
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 单道面试题折叠项:题目标题(点击展开) + 详细内容(考察点/出题分析/参考答案/追问)。
 */
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
      {/* 折叠标题按钮:点击展开/收起 */}
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
          {q.focus && <DetailItem label="考察点" content={q.focus} variant="muted" />}
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
 * @param label - 标签(如"考察点")
 * @param content - 内容文本
 * @param variant - 着色变体:muted(灰)/info(蓝)/accent(橙)
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

// ═══════════════════════ 模拟面试报告详情 ═══════════════════════

/**
 * 模拟面试报告详情视图(内联展示 + 全屏预览)。
 * 头部:标题、问答轮数、状态、来源分析跳转。
 */
function InterviewReportView({ detail }: { detail: InterviewReportDetail }) {
  const [fullscreen, setFullscreen] = useState(false); // 全屏开关
  const report = detail.report; // 最终报告(可能为空)
  const finished = detail.status === "finished" && !!report; // 是否已完成
  const abandoned = detail.status === "abandoned"; // 是否已放弃
  const statusText = finished ? "已完成" : abandoned ? "已放弃" : "进行中"; // 状态文案
  const title = `${detail.company_name || "未指定公司"} · ${detail.job_title || "未指定岗位"}`; // 标题
  const subtitle = `模拟面试记录 · ${detail.turns.length} 轮问答 · ${statusText}${report?.created_at ? ` · ${formatDate(report.created_at)}` : ""}`; // 副标题

  return (
    <>
      {/* ── 内联详情 ── */}
      <div className="max-w-[900px] mx-auto p-8 fade-in">
        {/* 报告头 */}
        <div className="flex items-start justify-between mb-6">
          <div>
            {/* 主标题 */}
            <h1 className="text-[22px] font-semibold text-stone-800 mb-1">
              {detail.company_name || "未指定公司"} · {detail.job_title || "未指定岗位"}
            </h1>
            {/* 副标题:轮数 + 状态 + 报告时间 */}
            <div className="text-[12px] text-stone-400">
              模拟面试记录 · {detail.turns.length} 轮问答 · {statusText}
              {report?.created_at && ` · ${formatDate(report.created_at)}`}
            </div>
            {/* 来源分析跳转(有 analysis_id 时显示) */}
            {detail.analysis_id && (
              <div className="mt-2">
                <SourceLink
                  label="来源分析"
                  value={detail.analysis_id}
                  href={`/history?tab=analysis&aid=${detail.analysis_id}`} // 跳转到来源分析
                />
              </div>
            )}
          </div>
          {/* 全屏按钮 */}
          <FullscreenButton onClick={() => setFullscreen(true)} />
        </div>

        {/* 报告主体 */}
        <InterviewReportBody detail={detail} />
      </div>

      {/* ── 全屏预览 ── */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={title}
        subtitle={`${subtitle} · 按 Esc 退出`}
        maxWidth={900}
      >
        {/* 全屏内容:复用同一主体 */}
        <InterviewReportBody detail={detail} />
      </FullscreenPreview>
    </>
  );
}

// ═══════════════════════ 模拟面试报告主体(内联与全屏共用) ═══════════════════════

/**
 * 模拟面试报告主体。
 * 未完成/已放弃:显示状态提示卡片 + 继续入口。
 * 已完成:总分环 + 总评 + 优势/薄弱 + 学习建议。
 * 无论状态如何,均展示完整问答回放。
 */
function InterviewReportBody({ detail }: { detail: InterviewReportDetail }) {
  const report = detail.report; // 最终报告
  const finished = detail.status === "finished" && !!report; // 是否已完成
  const abandoned = detail.status === "abandoned"; // 是否已放弃
  const score = report?.overall_score || 0; // 综合评分
  const sc = scoreColor(score);
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <>
      {/* ── 未完成/已放弃:状态提示卡片 ── */}
      {!finished ? (
        <div
          className="card p-6 mb-6 text-center"
          style={
            abandoned
              ? { background: "var(--bg-muted)", color: "var(--fg-muted)" } // 已放弃:灰
              : { background: "var(--accent-bg)", color: "var(--accent)" } // 进行中:橙
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
          {/* 未放弃时显示继续面试按钮 */}
          {!abandoned && (
            <Link href="/interview" className="btn btn-primary mt-3 inline-block">
              去继续面试 →
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* ── 总分评分环 ── */}
          <div className="card p-5 mb-4">
            <div className="flex items-center gap-5">
              {/* SVG 环形进度 */}
              <div className="relative w-20 h-20 shrink-0">
                <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                  {/* 灰色底环 */}
                  <circle cx="40" cy="40" r="34" fill="none" stroke="var(--border)" strokeWidth="6" />
                  {/* 彩色进度环:周长 ≈ 2π×34 ≈ 214 */}
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
                {/* 环中心分数 */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[22px] font-bold" style={{ color: scColor }}>{score}</span>
                </div>
              </div>
              <div className="flex-1">
                {/* 总结首行(截取第一行作为标题) */}
                <div className="text-[15px] font-semibold text-stone-800 mb-1">
                  {report!.summary.split("\n")[0] || "综合评估"}
                </div>
                {/* 完成轮数 + 公司 + 岗位 */}
                <div className="text-[12px] text-stone-500">
                  完成 {report!.rounds_completed} 轮 · {report!.company_name} · {report!.job_title}
                </div>
              </div>
            </div>
          </div>

          {/* ── 总评 ── */}
          {report!.summary && (
            <div className="card p-4 mb-4">
              <div className="text-[11px] font-semibold text-stone-500 mb-1.5">总评</div>
              <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
                {report!.summary}
              </div>
            </div>
          )}

          {/* ── 优势 / 薄弱 双列 ── */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* 表现优势(绿) */}
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

            {/* 薄弱环节(红) */}
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

          {/* ── 学习建议(橙色浅底序号列表) ── */}
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

      {/* ── 完整问答回放(任何状态下均展示) ── */}
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

/**
 * 单轮问答回放卡片。
 * 结构:问题头(Q 序号 + 评分徽章 + 题目)→ 回答 → AI 评价(含改进建议)。
 */
function TurnReplay({ turn }: { turn: InterviewTurn }) {
  const sc = scoreColor(turn.score, 10); // 按 10 分制计算颜色
  const scColor =
    sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";

  return (
    <div className="card overflow-hidden">
      {/* ── 问题头:橙色底 ── */}
      <div
        className="px-4 py-3"
        style={{ background: "var(--accent-bg)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 mb-1">
          {/* Q 序号徽章(橙底白字) */}
          <span className="text-[11px] font-bold text-white px-1.5 py-0.5 rounded" style={{ background: "var(--accent)" }}>
            Q{turn.turn_index}
          </span>
          {/* 评分徽章(已评价时显示,颜色随分数) */}
          {turn.evaluated && (
            <span
              className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
              style={{ background: "var(--bg-muted)", color: scColor }}
            >
              {turn.score}/10
            </span>
          )}
        </div>
        {/* 题目正文 */}
        <div className="text-[13px] text-stone-800 leading-relaxed">{turn.question}</div>
      </div>

      {/* ── 回答区 ── */}
      {turn.answer ? (
        <div className="px-4 py-3" style={{ background: "var(--bg-elevated)" }}>
          <div className="text-[11px] text-stone-500 font-semibold mb-1">你的回答</div>
          <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
            {turn.answer}
          </div>
        </div>
      ) : (
        // 未作答占位
        <div className="px-4 py-3 text-[12px] text-stone-400" style={{ background: "var(--bg-elevated)" }}>
          （未作答）
        </div>
      )}

      {/* ── AI 评价区(已评价时显示) ── */}
      {turn.evaluated && turn.evaluation && (
        <div
          className="px-4 py-3"
          style={{ background: "var(--bg-muted)", borderTop: "1px solid var(--border)" }}
        >
          {/* 评价标题(颜色随分数) */}
          <div className="text-[11px] font-semibold mb-1" style={{ color: scColor }}>
            AI 评价
          </div>
          {/* 评价正文 */}
          <div className="text-[12px] text-stone-700 leading-relaxed whitespace-pre-wrap">
            {turn.evaluation}
          </div>
          {/* 改进建议列表 */}
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
