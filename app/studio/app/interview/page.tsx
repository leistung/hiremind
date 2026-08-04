"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { scoreColor } from "@/lib/utils";
import ModelBadge from "@/components/ModelBadge";
import type {
  InterviewReport,
  InterviewState,
  StageConfig,
  StageSummary,
  StageProgressItem,
  WrittenQuestionItem,
  InterviewStageReport,
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

// sessionStorage 持久化结构:切换页面再回来时恢复面试状态
interface PersistedInterviewState {
  interviewId: string;
  phase: Phase;
  chat: ChatItem[];
  maxTurns: number;
  interviewModel: string;
  state: InterviewState | null;
  report: InterviewReport | null;
  stageConfigs: StageConfig[];
  writtenAnswers: Record<number, string>;
  savedAt: number;
}

const INTERVIEW_STATE_KEY = "hiremind:interview-state-v1";
// 启动中意图:启动面试后设置,恢复逻辑通过 listInterviews 查找后端已创建的面试
const INTERVIEW_STARTING_KEY = "hiremind:interview-starting-v1";
// 生成方案中意图:点击"智能生成"后设置,切回页面时恢复"生成中"状态并重新发起请求
const STAGES_RECOMMENDING_KEY = "hiremind:stages-recommending-v1";

// 阶段类型 → 中文展示名(用于进度条/卡片)
const STAGE_TYPE_LABELS: Record<string, string> = {
  written: "笔试",
  tech_1: "技术一面",
  tech_2: "技术二面",
  system_design: "系统设计面",
  behavioral: "行为面",
  hr: "人事面",
  boss: "老板面",
};

// 后端面试的活跃状态(用于 listInterviews 查找)
const ACTIVE_INTERVIEW_STATUSES = ["started", "answering", "evaluated", "in_progress"];

// 笔试就绪标记:后端 first_question 返回该值时表示进入笔试阶段(无单题)
const WRITTEN_READY = "__WRITTEN_READY__";

export default function InterviewPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <InterviewPage />
    </Suspense>
  );
}

function InterviewPage() {
  const searchParams = useSearchParams();
  const presetAnalysisId = searchParams.get("analysis") || "";

  // 恢复标记:仅初始化时读取一次 sessionStorage
  const [restored, setRestored] = useState(false);
  // 恢复中:从 sessionStorage 读到数据,正在从后端拉最新 state
  const [restoring, setRestoring] = useState(false);

  const [state, setState] = useState<InterviewState | null>(null);
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [maxTurns, setMaxTurns] = useState(2);
  // 本次面试启动时使用的模型(启动后修改全局配置不影响显示)
  const [interviewModel, setInterviewModel] = useState("");
  // 停止确认弹窗
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  // 分析记录 ID(提升到父级,启动中也能在输入框显示)
  const [analysisId, setAnalysisId] = useState(presetAnalysisId);
  // 多阶段:智能生成的阶段方案(空数组=未生成)
  const [stageConfigs, setStageConfigs] = useState<StageConfig[]>([]);
  // 期望面试轮次(2-6)
  const [expectedRounds, setExpectedRounds] = useState(4);
  // 正在智能生成阶段方案
  const [recommending, setRecommending] = useState(false);
  // 笔试答案(题目序号→回答)
  const [writtenAnswers, setWrittenAnswers] = useState<Record<number, string>>({});
  // 阶段完成总结(用于弹层)
  const [stageSummary, setStageSummary] = useState<StageSummary | null>(null);
  // 是否显示阶段总结弹层
  const [showStageSummary, setShowStageSummary] = useState(false);
  // 正在进入下一阶段
  const [advancing, setAdvancing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // 组件挂载状态:启动请求 await 后判断是否还能 setState
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 初始化恢复:优先级 STATE_KEY(已进入对话) > STARTING_KEY(启动中)
  // 不使用模块级变量,完全依赖 sessionStorage(跨页面导航可靠)
  useEffect(() => {
    // 1. 优先恢复已进入对话的面试状态(STATE_KEY)
    //    面试成功启动后,持久化 useEffect 会写入 STATE_KEY
    try {
      const raw = sessionStorage.getItem(INTERVIEW_STATE_KEY);
      if (raw) {
        const ps = JSON.parse(raw) as PersistedInterviewState;
        if (ps.interviewId && ps.state && ps.phase !== "idle" && ps.phase !== "finished") {
          setRestoring(true);
          setMaxTurns(ps.maxTurns || 2);
          setInterviewModel(ps.interviewModel || "");
          if (ps.stageConfigs) setStageConfigs(ps.stageConfigs);
          if (ps.writtenAnswers) setWrittenAnswers(ps.writtenAnswers);
          setChat(ps.chat || []);
          setReport(ps.report || null);
          setPhase(ps.phase);
          setAnalysisId(ps.state.interview_id ? "" : ""); // 不影响,面试已开始
          if (ps.state) setState(ps.state);
          // 如果有 STARTING_KEY,清除(面试已进入对话,不再需要)
          try { sessionStorage.removeItem(INTERVIEW_STARTING_KEY); } catch {}
          // 异步从后端拉取最新 state,仅用于同步 finished/abandoned 状态
          api.getInterviewState(ps.interviewId).then((r) => {
            setRestoring(false);
            if (r.success && r.state) {
              setState(r.state);
              if (r.state.status === "finished") {
                setPhase("finished");
              } else if (r.state.status === "abandoned") {
                sessionStorage.removeItem(INTERVIEW_STATE_KEY);
                setPhase("idle");
                setChat([]);
                setState(null);
                setError("上次面试已被放弃,请重新开始");
              }
            }
          }).catch(() => {
            setRestoring(false);
          });
          setRestored(true);
          return;
        }
        // 已完成或无 id,清掉避免重复恢复
        sessionStorage.removeItem(INTERVIEW_STATE_KEY);
      }
    } catch {}

    // 2. 恢复启动中状态(STARTING_KEY)
    //    用户点击"开始面试"后设置,后端可能还在处理(30s+)
    try {
      const sraw = sessionStorage.getItem(INTERVIEW_STARTING_KEY);
      if (sraw) {
        const s = JSON.parse(sraw);
        // 仅恢复 5 分钟内的启动意图
        if (s.savedAt && Date.now() - s.savedAt < 5 * 60 * 1000 && s.analysisId) {
          setStarting(true);
          setAnalysisId(s.analysisId);
          setMaxTurns(s.maxTurns || 2);
          setInterviewModel(s.interviewModel || "");
          if (s.stageConfigs) setStageConfigs(s.stageConfigs);
          setRestored(true);
          (async () => {
            // 后端可能还在处理启动请求(30s+),重试查找多次
            for (let attempt = 0; attempt < 8; attempt++) {
              try {
                const list = await api.listInterviews();
                if (!mountedRef.current) return;
                const recent = list.interviews.find(
                  (iv) => iv.analysis_id === s.analysisId && ACTIVE_INTERVIEW_STATUSES.includes(iv.status)
                );
                if (recent) {
                  const sr = await api.getInterviewState(recent.id);
                  if (!mountedRef.current) return;
                  if (sr.success && sr.state) {
                    setState(sr.state);
                    if (sr.state.current_stage_type === "written") {
                      setChat([
                        { kind: "system", content: `面试开始 · ${sr.state.company_name} · ${sr.state.job_title}`, ts: Date.now() },
                      ]);
                    } else {
                      setChat([
                        { kind: "system", content: `面试开始 · ${sr.state.company_name} · ${sr.state.job_title} · 共 ${sr.state.max_turns} 题`, ts: Date.now() },
                        { kind: "question", content: sr.state.current_question || "", focus: sr.state.current_focus || undefined, rationale: sr.state.current_rationale || undefined, referenceAnswer: sr.state.current_reference_answer || undefined, ts: Date.now() },
                      ]);
                      setTimeout(() => answerRef.current?.focus(), 100);
                    }
                    setPhase("answering");
                    setStarting(false);
                    try { sessionStorage.removeItem(INTERVIEW_STARTING_KEY); } catch {}
                    return;
                  }
                }
              } catch {}
              // 后端尚未创建面试,等待后重试
              if (attempt < 7) await new Promise(r => setTimeout(r, 5000));
            }
            // 重试耗尽仍未找到:清除启动意图,回到 StartView
            if (!mountedRef.current) return;
            try { sessionStorage.removeItem(INTERVIEW_STARTING_KEY); } catch {}
            setStarting(false);
            setPhase("idle");
          })();
          return;
        }
        // 过期,清除
        try { sessionStorage.removeItem(INTERVIEW_STARTING_KEY); } catch {}
      }
    } catch {}

    // 3. 恢复"生成方案中"状态:recommendStages 被导航中止,需重新发起
    try {
      const rraw = sessionStorage.getItem(STAGES_RECOMMENDING_KEY);
      if (rraw) {
        const r = JSON.parse(rraw);
        // 仅恢复 5 分钟内的生成意图
        if (r.savedAt && Date.now() - r.savedAt < 5 * 60 * 1000 && r.analysisId) {
          setRestored(true);
          setAnalysisId(r.analysisId);
          setExpectedRounds(r.expectedRounds || 4);
          setRecommending(true);
          // 重新发起生成请求(recommendStages 是无状态的,可安全重试)
          (async () => {
            try {
              const resp = await api.recommendStages(r.analysisId, r.expectedRounds || 4);
              if (!mountedRef.current) return;
              if (resp.success && resp.stages && resp.stages.length > 0) {
                setStageConfigs(resp.stages.map((s) => ({ ...s, enabled: true })));
              } else {
                setError(resp.error || "生成失败,请确认分析记录已生成报告");
              }
            } catch {
              if (!mountedRef.current) return;
              setError("请求失败,请检查后端服务");
            } finally {
              if (mountedRef.current) {
                setRecommending(false);
                try { sessionStorage.removeItem(STAGES_RECOMMENDING_KEY); } catch {}
              }
            }
          })();
          return;
        }
        try { sessionStorage.removeItem(STAGES_RECOMMENDING_KEY); } catch {}
      }
    } catch {}

    setRestored(true);
  }, []);

  // 持久化:面试进行中任一状态变化时同步到 sessionStorage
  useEffect(() => {
    if (!restored) return;
    // idle/finished 不持久化(避免恢复已完成面试)
    if (phase === "idle" || phase === "finished") {
      try {
        sessionStorage.removeItem(INTERVIEW_STATE_KEY);
      } catch {}
      return;
    }
    if (!state?.interview_id) return;
    const ps: PersistedInterviewState = {
      interviewId: state.interview_id,
      phase,
      chat,
      maxTurns,
      interviewModel,
      state,
      report,
      stageConfigs,
      writtenAnswers,
      savedAt: Date.now(),
    };
    try {
      sessionStorage.setItem(INTERVIEW_STATE_KEY, JSON.stringify(ps));
      // 调试:确认写入
      console.log("[interview] persisted to sessionStorage:", ps.interviewId, ps.phase);
    } catch {}
  }, [restored, phase, chat, maxTurns, interviewModel, state, report, stageConfigs, writtenAnswers]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat, phase]);

  // 智能生成面试阶段方案:调用后端 LLM 根据岗位/公司/期望轮次生成
  async function generateStages() {
    if (!analysisId.trim() || recommending) return;
    setRecommending(true);
    setError("");
    // 立即持久化"生成中"意图:切回页面时恢复并重新发起请求
    // (recommendStages 是独立请求,导航中止后无法在后端继续,必须重新调用)
    try {
      sessionStorage.setItem(STAGES_RECOMMENDING_KEY, JSON.stringify({
        analysisId: analysisId.trim(),
        expectedRounds,
        savedAt: Date.now(),
      }));
    } catch {}
    try {
      const r = await api.recommendStages(analysisId.trim(), expectedRounds);
      if (!mountedRef.current) return;
      if (!r.success || !r.stages || r.stages.length === 0) {
        setError(r.error || "生成失败,请确认分析记录已生成报告");
        return;
      }
      // 全部启用(用户确认后可整体启动)
      setStageConfigs(r.stages.map((s) => ({ ...s, enabled: true })));
    } catch (err) {
      if (!mountedRef.current) return;
      setError("请求失败,请检查后端服务");
    } finally {
      if (mountedRef.current) {
        setRecommending(false);
      }
      // 无论成功失败,只要组件仍挂载就清除"生成中"意图
      // (组件卸载时保留,供恢复使用)
      if (mountedRef.current) {
        try { sessionStorage.removeItem(STAGES_RECOMMENDING_KEY); } catch {}
      }
    }
  }

  async function startWithAnalysis(idToStart: string) {
    setStarting(true);
    setAnalysisId(idToStart);
    setError("");
    setChat([]);
    setReport(null);
    setWrittenAnswers({});
    setShowStageSummary(false);
    setStageSummary(null);

    // 使用智能生成的阶段方案(每轮 question_count 已由 LLM 确定)
    const stages: StageConfig[] = stageConfigs.filter((s) => s.enabled);

    // 立即持久化启动意图:用户切换页面后通过 listInterviews 恢复
    // 这是唯一的恢复机制,不依赖模块级变量
    try {
      sessionStorage.setItem(INTERVIEW_STARTING_KEY, JSON.stringify({
        analysisId: idToStart,
        maxTurns,
        interviewModel: "",
        stageConfigs: stages,
        savedAt: Date.now(),
      }));
    } catch {}

    try {
      // 并行拉取当前模型(非阻塞,失败不影响启动)
      try {
        const info = await api.getModelInfo();
        if (mountedRef.current) setInterviewModel(info.model || "");
      } catch {}

      const r = await api.startInterview(idToStart, maxTurns, stages);
      // 组件已卸载(用户切走了):不更新状态,保留 STARTING_KEY 供恢复逻辑使用
      if (!mountedRef.current) return;
      if (!r.success || !r.state) {
        setError(r.error || "启动失败,请先在分析页生成报告");
        setPhase("idle");
        try { sessionStorage.removeItem(INTERVIEW_STARTING_KEY); } catch {}
        return;
      }
      setState(r.state);
      const firstQ = r.first_question || r.state.current_question || "";
      // 笔试就绪:不添加 question 消息,phase 设为 answering 显示笔试视图
      if (firstQ === WRITTEN_READY || r.state.current_stage_type === "written") {
        setChat([
          {
            kind: "system",
            content: `面试开始 · ${r.state.company_name} · ${r.state.job_title}`,
            ts: Date.now(),
          },
        ]);
        setPhase("answering");
      } else {
        setChat([
          {
            kind: "system",
            content: `面试开始 · ${r.state.company_name} · ${r.state.job_title} · 共 ${r.state.max_turns} 题`,
            ts: Date.now(),
          },
          {
            kind: "question",
            content: firstQ,
            focus: r.state.current_focus || undefined,
            rationale: r.state.current_rationale || undefined,
            referenceAnswer: r.state.current_reference_answer || undefined,
            ts: Date.now(),
          },
        ]);
        setPhase("answering");
        setTimeout(() => answerRef.current?.focus(), 100);
      }
      // 成功启动:清除 STARTING_KEY(持久化 useEffect 会自动写入 STATE_KEY)
      try { sessionStorage.removeItem(INTERVIEW_STARTING_KEY); } catch {}
    } catch (err) {
      // 请求失败(可能是导航中止或网络错误)
      // 不清除 STARTING_KEY:后端可能已在处理,恢复逻辑通过 listInterviews 查找
      console.log("[start] error:", (err as Error)?.message, "preserving STARTING_KEY for recovery");
      // 如果组件仍挂载,说明是真正的网络错误(不是导航中止)
      if (!mountedRef.current) return;
      setError("启动请求失败,后端可能仍在处理,请稍后刷新页面查看");
      setPhase("idle");
      // 不清除 STARTING_KEY,让用户刷新页面时能通过 listInterviews 恢复
    } finally {
      if (mountedRef.current) {
        setStarting(false);
      }
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
      } else if (r.stage_completed) {
        // 当前阶段完成:显示阶段总结弹层,不继续出题
        setState(r.state || state);
        setStageSummary(r.stage_summary || null);
        setShowStageSummary(true);
        setPhase("next");
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

  // 笔试批量提交
  async function submitWrittenAnswers() {
    if (!state || phase !== "answering") return;
    const questions = state.written_questions || [];
    if (questions.length === 0) return;
    setPhase("evaluating");
    setError("");
    // 构造 answers:key 是字符串序号("0", "1", ...)
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[String(i)] = (writtenAnswers[i] || "").trim();
    });
    try {
      const r = await api.submitWrittenAnswers(state.interview_id, answers);
      if (!r.success) {
        setError(r.error || "提交失败");
        setPhase("answering");
        return;
      }
      setState(r.state || state);
      // 显示阶段总结弹层
      setStageSummary({
        stage_type: state.current_stage_type || null,
        stage_name: state.current_stage_name || "笔试",
        stage_score: r.stage_score || 0,
        stage_summary: r.stage_summary || "",
        promotion_hint: r.promotion_hint || "",
      });
      setShowStageSummary(true);
      setPhase("next");
    } catch {
      setError("网络错误");
      setPhase("answering");
    }
  }

  // 进入下一阶段(多阶段模式)
  async function advanceToNextStage() {
    if (!state || advancing) return;
    setAdvancing(true);
    setError("");
    try {
      const r = await api.advanceStage(state.interview_id);
      if (!r.success) {
        setError(r.error || "进入下一阶段失败");
        setAdvancing(false);
        return;
      }
      setState(r.state || state);
      setShowStageSummary(false);
      setStageSummary(null);
      if (r.finished) {
        // 全部阶段结束,显示最终报告
        setReport(r.report || null);
        setChat((c) => [
          ...c,
          { kind: "system", content: "面试结束,正在生成最终报告…", ts: Date.now() },
        ]);
        setPhase("finished");
      } else if (r.written_ready) {
        // 下一阶段是笔试:清空笔试答案,显示笔试视图
        setWrittenAnswers({});
        setPhase("answering");
      } else if (r.next_question) {
        // 下一阶段是对话:添加阶段分隔条系统消息
        const stageName = r.state?.current_stage_name || "新阶段";
        setChat((c) => [
          ...c,
          { kind: "system", content: `—— ${stageName} 开始 ——`, ts: Date.now() },
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
    } finally {
      setAdvancing(false);
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

  // 请求停止:弹确认框
  function requestStop() {
    setShowStopConfirm(true);
  }

  // 确认停止:调用 abandon 接口,不生成报告,清空状态回到 StartView
  async function confirmStopInterview() {
    setShowStopConfirm(false);
    const idToStop = state?.interview_id;
    if (idToStop) {
      try {
        await api.abandonInterview(idToStop);
      } catch {}
    }
    // 清空所有状态(包括启动中)
    setState(null);
    setReport(null);
    setChat([]);
    setAnswer("");
    setError("");
    setPhase("idle");
    setInterviewModel("");
    setStarting(false);
    setWrittenAnswers({});
    setShowStageSummary(false);
    setStageSummary(null);
    setAdvancing(false);
    setStageConfigs([]);
    try {
      sessionStorage.removeItem(INTERVIEW_STATE_KEY);
      sessionStorage.removeItem(INTERVIEW_STARTING_KEY);
      sessionStorage.removeItem(STAGES_RECOMMENDING_KEY);
    } catch {}
  }

  // 取消停止:只关弹窗
  function cancelStop() {
    setShowStopConfirm(false);
  }

  const started = state !== null;
  // 当前是否处于笔试阶段(显示笔试作答视图,替代对话流)
  const isWrittenStage = !!state && state.current_stage_type === "written" && phase !== "finished";

  return (
    <div className="h-screen flex flex-col">
      {/* 右侧:对话区 / 启动区 / 报告区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {restoring ? (
          // 恢复中:从 sessionStorage 读到数据,正在从后端拉最新 state
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-8 h-8 rounded-full border-2 border-orange-200 border-t-orange-600 animate-spin mx-auto mb-3" />
              <div className="text-[13px] text-stone-500">正在恢复面试…</div>
            </div>
          </div>
        ) : !started && phase === "idle" ? (
          <StartView
            analysisId={analysisId}
            setAnalysisId={setAnalysisId}
            starting={starting}
            stageConfigs={stageConfigs}
            expectedRounds={expectedRounds}
            setExpectedRounds={setExpectedRounds}
            recommending={recommending}
            onGenerate={generateStages}
            onStart={startWithAnalysis}
            error={error}
          />
        ) : (
          <>
            {/* 顶部信息条 */}
            {state && (
              <div
                className="px-6 py-3 border-b shrink-0"
                style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="text-[14px] font-semibold text-stone-800">
                      {state.company_name} · {state.job_title}
                    </div>
                    <span className="badge badge-muted">
                      第 {state.turn_index} / {state.max_turns} 题
                    </span>
                    {phase === "finished" && (
                      <span className="badge badge-success">已完成</span>
                    )}
                    {interviewModel && <ModelBadge variant="inline" model={interviewModel} />}
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
                    {phase !== "finished" && (
                      <button
                        onClick={requestStop}
                        className="btn btn-ghost text-[12px]"
                        style={{ color: "var(--danger)" }}
                      >
                        停止
                      </button>
                    )}
                  </div>
                </div>
                {/* 多阶段进度条 */}
                {state.is_multi_stage && state.stages_progress && state.stages_progress.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {state.stages_progress.map((s, i) => {
                      const done = s.status === "completed";
                      const current = s.status === "in_progress";
                      return (
                        <div key={i} className="flex items-center gap-1.5">
                          {i > 0 && <span className="text-[11px] text-stone-300">→</span>}
                          <span
                            className="px-2 py-0.5 rounded-full text-[11px] flex items-center gap-1"
                            style={{
                              background: done
                                ? "var(--success-soft, #dcfce7)"
                                : current
                                ? "var(--accent-bg)"
                                : "var(--bg-muted)",
                              color: done
                                ? "var(--success)"
                                : current
                                ? "var(--accent)"
                                : "var(--fg-muted)",
                              fontWeight: current ? 600 : 400,
                              border: current ? "1px solid var(--accent)" : "1px solid transparent",
                            }}
                          >
                            <span>{done ? "✓" : current ? "●" : "○"}</span>
                            <span>{s.stage_name}</span>
                            {done && s.stage_score > 0 && (
                              <span style={{ opacity: 0.8 }}>{s.stage_score}分</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 停止确认弹窗 */}
            {showStopConfirm && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center"
                style={{ background: "rgba(0,0,0,0.4)" }}
                onClick={cancelStop}
              >
                <div
                  className="max-w-[360px] w-full mx-4 rounded-xl p-5"
                  style={{ background: "var(--bg-elevated)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-[15px] font-semibold text-stone-800 mb-2">
                    确认停止面试?
                  </div>
                  <div className="text-[12px] text-stone-500 leading-relaxed mb-4">
                    停止后本次面试将被标记为「已放弃」,不生成最终报告,且无法恢复。如需报告请用「提前结束」。
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={cancelStop} className="btn btn-ghost text-[12px]">
                      取消
                    </button>
                    <button
                      onClick={confirmStopInterview}
                      className="btn text-[12px]"
                      style={{ background: "var(--danger)", color: "#fff" }}
                    >
                      确认停止
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 笔试视图 or 对话流 */}
            {isWrittenStage ? (
              <WrittenTestView
                questions={state?.written_questions || []}
                answers={writtenAnswers}
                onAnswerChange={(idx, val) =>
                  setWrittenAnswers((prev) => ({ ...prev, [idx]: val }))
                }
                onSubmit={submitWrittenAnswers}
                submitting={phase === "evaluating"}
              />
            ) : (
              <>
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

                {state && phase === "next" && !showStageSummary && (
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
              </>
            )}

            {phase === "finished" && report && (
              <FinalReportView report={report} />
            )}

            {/* 阶段总结弹层 */}
            {showStageSummary && stageSummary && (
              <StageSummaryModal
                summary={stageSummary}
                advancing={advancing}
                onAdvance={advanceToNextStage}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── 启动视图 ──
function StartView({
  analysisId,
  setAnalysisId,
  starting,
  stageConfigs,
  expectedRounds,
  setExpectedRounds,
  recommending,
  onGenerate,
  onStart,
  error,
}: {
  analysisId: string;
  setAnalysisId: (v: string) => void;
  starting: boolean;
  stageConfigs: StageConfig[];
  expectedRounds: number;
  setExpectedRounds: (n: number) => void;
  recommending: boolean;
  onGenerate: () => void;
  onStart: (analysisId: string) => void;
  error: string;
}) {
  const hasPlan = stageConfigs.length > 0;
  const busy = recommending || starting;

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-[520px] w-full">
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
            根据岗位、公司、薪资智能规划面试轮次与题型,模拟大厂真实面试流程
          </p>
        </div>

        <div className="card p-5 space-y-4">
          <div>
            <label className="label">分析记录 ID *</label>
            <input
              className="input"
              value={analysisId}
              onChange={(e) => setAnalysisId(e.target.value)}
              placeholder="粘贴分析页生成的 analysis_id"
              disabled={busy}
            />
            <div className="text-[11px] text-stone-400 mt-1.5">
              在
              <Link href="/analysis" className="text-orange-700 mx-1">面试分析</Link>
              页生成报告后,可点击「去模拟面试」直接进入
            </div>
          </div>

          <div>
            <label className="label">期望面试轮次</label>
            <div className="flex items-center gap-2">
              {[2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  onClick={() => setExpectedRounds(n)}
                  disabled={busy}
                  className="btn btn-secondary flex-1"
                  style={
                    expectedRounds === n
                      ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                      : undefined
                  }
                >
                  {n}
                </button>
              ))}
              <span className="text-[11px] text-stone-400 shrink-0">轮</span>
            </div>
            <div className="text-[11px] text-stone-400 mt-1.5">
              系统将根据岗位级别与薪资自动决定每轮类型(笔试/技术面/系统设计/HR 等)与题数
            </div>
          </div>

          {/* 智能生成的阶段方案 */}
          {hasPlan && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="label mb-0">面试方案</label>
                <button
                  onClick={onGenerate}
                  disabled={busy}
                  className="text-[11px] text-orange-700 hover:underline"
                >
                  重新生成
                </button>
              </div>
              <div className="space-y-2">
                {stageConfigs.map((s, i) => (
                  <div
                    key={i}
                    className="px-3 py-2.5 rounded-lg"
                    style={{ background: "var(--bg-muted)", border: "1px solid var(--border)" }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                        style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
                      >
                        {i + 1}
                      </span>
                      <span className="text-[13px] font-semibold text-stone-800">{s.stage_name}</span>
                      <span className="badge badge-muted text-[10px]">
                        {STAGE_TYPE_LABELS[s.stage_type] || s.stage_type}
                      </span>
                      <span className="ml-auto text-[11px] text-stone-500">
                        共 {s.question_count} 题
                      </span>
                    </div>
                    {s.focus && (
                      <div className="text-[11px] text-stone-600 ml-7">
                        <span className="text-stone-400">侧重:</span> {s.focus}
                      </div>
                    )}
                    {s.rationale && (
                      <div className="text-[11px] text-stone-400 ml-7 mt-0.5">
                        {s.rationale}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div
              className="px-3 py-2 rounded-lg text-[12px]"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}

          {!hasPlan ? (
            <button
              onClick={onGenerate}
              disabled={!analysisId.trim() || recommending}
              className="btn btn-primary w-full"
              style={{ padding: "10px 16px", fontSize: 14 }}
            >
              {recommending ? "智能生成中…" : "智能生成面试方案"}
            </button>
          ) : (
            <button
              onClick={() => onStart(analysisId)}
              disabled={!analysisId.trim() || starting}
              className="btn btn-primary w-full"
              style={{ padding: "10px 16px", fontSize: 14 }}
            >
              {starting ? "启动中…" : "确认开始面试"}
            </button>
          )}
        </div>

        {/* 当前模型提示:启动面试后修改模型不影响本次面试 */}
        <div className="flex justify-center mt-4">
          <ModelBadge />
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

// ── 笔试作答视图 ──
function WrittenTestView({
  questions,
  answers,
  onAnswerChange,
  onSubmit,
  submitting,
}: {
  questions: WrittenQuestionItem[];
  answers: Record<number, string>;
  onAnswerChange: (index: number, value: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const answeredCount = questions.filter((_, i) => (answers[i] || "").trim()).length;
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-[820px] mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-[15px] font-semibold text-stone-800">笔试作答</div>
          <span className="badge badge-muted text-[11px]">
            已答 {answeredCount} / {questions.length}
          </span>
        </div>
        {questions.map((q, i) => (
          <div key={i} className="card p-4">
            <div className="flex items-start gap-2 mb-2">
              <span
                className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold"
                style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
              >
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                {(q.focus || q.direction) && (
                  <div className="mb-1">
                    {q.focus && <span className="badge badge-accent mr-1.5">{q.focus}</span>}
                    {q.direction && <span className="badge badge-muted mr-1.5">{q.direction}</span>}
                  </div>
                )}
                <div className="text-[13px] font-semibold text-stone-800">
                  {q.title}
                </div>
              </div>
            </div>
            <div className="text-[13px] text-stone-700 leading-relaxed whitespace-pre-wrap mb-3 ml-8">
              {q.question}
            </div>
            <textarea
              value={answers[i] || ""}
              onChange={(e) => onAnswerChange(i, e.target.value)}
              rows={5}
              className="input"
              placeholder={`请在此输入第 ${i + 1} 题的回答…`}
              disabled={submitting}
            />
          </div>
        ))}
        <div className="flex items-center justify-between pt-2 sticky bottom-0 py-3 -mx-6 px-6"
          style={{ background: "var(--bg)" }}
        >
          <div className="text-[11px] text-stone-400">
            全部作答完成后点击「提交全部答案」
          </div>
          <button
            onClick={onSubmit}
            disabled={submitting || answeredCount === 0}
            className="btn btn-primary"
          >
            {submitting ? "提交中…" : "提交全部答案"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 阶段总结弹层 ──
function StageSummaryModal({
  summary,
  advancing,
  onAdvance,
}: {
  summary: StageSummary;
  advancing: boolean;
  onAdvance: () => void;
}) {
  const sc = scoreColor(summary.stage_score);
  const scColor = sc === "success" ? "var(--success)" : sc === "warning" ? "var(--warning)" : "var(--danger)";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
    >
      <div
        className="max-w-[420px] w-full mx-4 rounded-xl p-5 fade-in"
        style={{ background: "var(--bg-elevated)" }}
      >
        <div className="text-[11px] text-stone-400 mb-1">阶段完成</div>
        <div className="text-[17px] font-semibold text-stone-800 mb-3">
          {summary.stage_name}
        </div>
        <div className="flex items-center gap-4 mb-4">
          <div className="relative w-16 h-16 shrink-0">
            <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="27" fill="none" stroke="var(--border)" strokeWidth="5" />
              <circle
                cx="32"
                cy="32"
                r="27"
                fill="none"
                stroke={scColor}
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={`${(summary.stage_score / 100) * 170} 170`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[18px] font-bold" style={{ color: scColor }}>{summary.stage_score}</span>
            </div>
          </div>
          <div className="flex-1 text-[12px] text-stone-600 leading-relaxed">
            {summary.stage_summary || "—"}
          </div>
        </div>
        {summary.promotion_hint && (
          <div
            className="px-3 py-2 rounded-lg text-[12px] mb-4 leading-relaxed"
            style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
          >
            {summary.promotion_hint}
          </div>
        )}
        <div className="flex justify-end">
          <button
            onClick={onAdvance}
            disabled={advancing}
            className="btn btn-primary"
          >
            {advancing ? "进入中…" : "进入下一阶段 →"}
          </button>
        </div>
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
                共 {report.rounds_completed} 题 · {report.company_name} · {report.job_title}
              </div>
            </div>
          </div>
        </div>

        {/* 分阶段成绩 */}
        {report.stages && report.stages.length > 0 && (
          <div className="mb-4">
            <div className="text-[11px] font-semibold text-stone-500 mb-2">分阶段成绩</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {report.stages.map((st, i) => {
                const stSc = scoreColor(st.stage_score);
                const stColor = stSc === "success" ? "var(--success)" : stSc === "warning" ? "var(--warning)" : "var(--danger)";
                return (
                  <div key={i} className="card p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="relative w-12 h-12 shrink-0">
                        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
                          <circle cx="24" cy="24" r="20" fill="none" stroke="var(--border)" strokeWidth="4" />
                          <circle
                            cx="24"
                            cy="24"
                            r="20"
                            fill="none"
                            stroke={stColor}
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeDasharray={`${(st.stage_score / 100) * 126} 126`}
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-[13px] font-bold" style={{ color: stColor }}>{st.stage_score}</span>
                        </div>
                      </div>
                      <div className="text-[12px] font-semibold text-stone-800 leading-tight">
                        {st.stage_name}
                      </div>
                    </div>
                    <div className="text-[11px] text-stone-500 leading-relaxed line-clamp-3">
                      {st.stage_summary || "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

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
