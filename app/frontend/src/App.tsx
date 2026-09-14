import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Bell, BriefcaseBusiness, ChevronDown, ChevronRight, CircleHelp, CircleUserRound, ClipboardCheck, FileText, Gauge, History, LayoutDashboard, Lightbulb, Menu, Moon, Play, Plus, Settings, Sparkles, Sun, Target, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api, type Analysis, type AnalysisResult, type InterviewListItem, type Position, type Resume } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ResumesPage } from "@/pages/ResumesPage";
import { PositionsPage } from "@/pages/PositionsPage";
import { AnalysisPage } from "@/pages/AnalysisPage";
import { InterviewPage } from "@/pages/InterviewPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { SettingsPage } from "@/pages/SettingsPage";

type View = "总览" | "简历" | "职位" | "分析" | "模拟面试" | "历史" | "设置";
type DashboardData = { resumes: Resume[]; positions: Position[]; analyses: Analysis[]; featuredAnalysis: Analysis | null; interviews: InterviewListItem[]; result: AnalysisResult | null; online: boolean };
const nav: { label: View; icon: ComponentType<{ size?: number }> }[] = [{ label: "总览", icon: LayoutDashboard }, { label: "简历", icon: FileText }, { label: "职位", icon: BriefcaseBusiness }, { label: "分析", icon: Gauge }, { label: "模拟面试", icon: UserRound }, { label: "历史", icon: History }, { label: "设置", icon: Settings }];
const emptyDashboard: DashboardData = { resumes: [], positions: [], analyses: [], featuredAnalysis: null, interviews: [], result: null, online: false };
const analysisId = (item?: Analysis) => item?.id || item?.analysis_id || "";
const displayDate = (value?: string) => value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "刚刚";

function useDashboardData() {
  const [data, setData] = useState<DashboardData>(emptyDashboard);

  useEffect(() => {
    void (async () => {
      try {
        const [health, resumes, positions, analyses, interviews] = await Promise.all([
          api.health(), api.resumes(), api.positions(), api.analyses(), api.interviews(),
        ]);
        const featuredAnalysis = analyses.analyses.find(item => item.status === "completed") || analyses.analyses[0] || null;
        let result: AnalysisResult | null = null;
        if (featuredAnalysis) {
          try {
            result = (await api.analysis(analysisId(featuredAnalysis))).result || null;
          } catch {
            // The workspace remains usable even when one historic report is incomplete.
          }
        }
        const meta = featuredAnalysis as (Analysis & { resume_id?: string; position_id?: string }) | null;
        const resumeId = meta?.resume_id || meta?.metadata?.resume_id;
        const positionId = meta?.position_id || meta?.metadata?.position_id;
        const prioritize = <T extends { id: string }>(items: T[], id?: string) =>
          id ? [...items].sort((a, b) => Number(b.id === id) - Number(a.id === id)) : items;
        const orderedAnalyses = featuredAnalysis
          ? [featuredAnalysis, ...analyses.analyses.filter(item => analysisId(item) !== analysisId(featuredAnalysis))]
          : analyses.analyses;
        setData({
          resumes: prioritize(resumes.resumes, resumeId),
          positions: prioritize(positions.positions, positionId),
          analyses: orderedAnalyses,
          featuredAnalysis,
          interviews: interviews.interviews,
          result,
          online: Boolean(health.status),
        });
      } catch {
        setData(current => ({ ...current, online: false }));
      }
    })();
  }, []);

  return data;
}

function ContextItem({ icon: Icon, eyebrow, title, meta, onClick }: { icon: ComponentType<{ size?: number }>; eyebrow: string; title: string; meta: string; onClick?: () => void }) { return <button onClick={onClick} className="os-context-item"><span className="os-context-icon"><Icon size={18} /></span><span className="os-context-copy"><small>{eyebrow}</small><b>{title}</b><em>{meta}</em></span><ChevronRight size={16} /></button>; }
function Metric({ title, value, note, icon: Icon, tone, onClick }: { title: string; value: string; note: string; icon: ComponentType<{ size?: number }>; tone: string; onClick: () => void }) { return <button onClick={onClick} className="os-metric"><span className={`os-metric-icon ${tone}`}><Icon size={20} /></span><span><small>{title}</small><b>{value}</b><em>{note}</em></span><ChevronRight size={17} /></button>; }

function WorkflowPanel({ result }: { result: AnalysisResult | null }) { const labels = ["解析 JD", "解析简历", "匹配度", "业务场景", "履历风险", "面试题", "备考建议"]; return <Card className="os-panel os-workflow"><div className="os-panel-title"><span><Sparkles size={19} />分析流程</span><small>{result ? "7 个节点" : "等待开始"}</small></div><div className="os-step-list">{labels.map((label, index) => <div key={label} className={cn("os-step", result && "done")}><span>{index + 1}</span><i /><b>{label}</b><em>{result ? "已完成" : "待开始"}</em></div>)}</div><button className="os-panel-footer">查看分析报告 <ChevronRight size={15} /></button></Card>; }
function InterviewPanel({ interviews, go }: { interviews: DashboardData["interviews"]; go: (view: View) => void }) { const active = interviews.slice(0, 3); return <Card className="os-panel"><div className="os-panel-title"><span><ClipboardCheck size={19} />模拟面试</span><small>{active.length ? `${active.length} 条记录` : "还未开始"}</small></div>{active.length ? <div className="os-compact-list">{active.map(item => <button onClick={() => go("模拟面试")} key={item.id}><span><b>{item.company_name || "模拟面试"}</b><small>{item.job_title || "岗位准备"} · {item.status}</small></span><Badge variant="progress">{item.turns || 0} 题</Badge><ChevronRight size={15} /></button>)}</div> : <div className="os-panel-empty">准备好后，开启一场针对性的 AI 模拟面试。</div>}<button onClick={() => go("模拟面试")} className="os-primary-cta"><Play size={15} fill="currentColor" />开始模拟面试</button></Card>; }
function AdvicePanel({ result, go }: { result: AnalysisResult | null; go: (view: View) => void }) { const advice = result?.preparation_tips.slice(0, 3) || ["选择一份简历与职位，生成你的专属备考建议。", "分析会识别技能匹配、履历风险与高频场景。", "完成分析后可直接开始模拟面试。"]; return <Card className="os-panel"><div className="os-panel-title"><span><Lightbulb size={19} />AI 建议</span><small>{result ? `${advice.length} 条建议` : "开始准备"}</small></div><div className="os-advice-list">{advice.map((text, index) => <button key={text}><Badge variant={index === 0 ? "progress" : "success"}>{index === 0 ? "优先处理" : "下一步"}</Badge><span><b>{result ? ["补齐关键技术细节", "强化业务场景回答", "优化简历关键词"][index] : "建立准备计划"}</b><small>{text}</small></span></button>)}</div><button onClick={() => go(result ? "历史" : "分析")} className="os-panel-footer">{result ? "查看完整报告" : "创建首次分析"}<ChevronRight size={15} /></button></Card>; }

function WorkspaceDashboard({ data, go }: { data: DashboardData; go: (view: View) => void }) { const recent = data.featuredAnalysis; const score = data.result?.match_analysis.match_score; return <div className="os-dashboard"><div className="os-dashboard-header"><div><h1>求职准备工作台</h1><p>从简历打磨到面试演练，把每一次准备做成可执行的计划。</p></div><button onClick={() => go("分析")} className="os-resume-button"><span><Play size={16} fill="currentColor" /></span><b>{recent ? "继续岗位分析" : "创建岗位分析"}<small>{recent?.title || "选择简历与职位，建立第一份准备计划"}</small></b><ChevronRight size={17} /></button></div><div className="os-highlight-grid"><Card className="os-score-card"><div className="os-card-heading"><b>岗位匹配度</b><Badge variant={score && score >= 70 ? "success" : "default"}>{score ? "已生成" : "未分析"}</Badge></div><div className="os-score-content"><div className="os-score-ring" style={{ background: score ? `conic-gradient(#318a6e 0 ${score * 3.6}deg, #e7f1ed ${score * 3.6}deg)` : undefined }}><div><strong>{score || "—"}</strong><small>匹配度</small></div></div><p><b>{score ? "整体匹配度已生成" : "还没有岗位分析"}</b><span>{score ? "从报告中查看技术、经历与业务场景的匹配结果。" : "从一份简历和职位 JD 开始，系统会建立完整的分析报告。"}</span></p></div><div className="os-chip-row"><Badge variant="success">技术栈</Badge><Badge variant="success">经历匹配</Badge></div></Card><button onClick={() => go("历史")} className="os-analysis-card"><div><small>最近一次岗位分析</small><h2>{data.result?.company_name || recent?.title || "等待第一份分析"}</h2><b>{data.result?.job_title || "岗位匹配 · 场景推演 · 面试题"}</b></div><span><Badge className="os-dark-badge" variant="default">{recent?.status === "completed" ? "分析完成" : "准备就绪"}</Badge><em>{score ? `${score} 分 · 7 个分析节点` : "创建后实时查看 7 个分析节点"}</em></span><div className="os-fake-chart">{Array.from({ length: 7 }).map((_, index) => <i key={index} />)}</div></button></div><div className="os-metric-row"><Metric title="简历完整度" value={data.resumes.length ? "已建立" : "0%"} note={data.resumes.length ? `${data.resumes.length} 份简历可用` : "添加第一份简历"} icon={FileText} tone="green" onClick={() => go("简历")} /><Metric title="目标职位" value={String(data.positions.length)} note={data.positions.length ? "已保存 JD" : "添加目标岗位"} icon={BriefcaseBusiness} tone="purple" onClick={() => go("职位")} /><Metric title="风险与待办" value={String(data.result?.risks.length || 0)} note={data.result ? "来自最近分析" : "完成分析后生成"} icon={Target} tone="orange" onClick={() => go("分析")} /></div><div className="os-bottom-grid"><WorkflowPanel result={data.result} /><InterviewPanel interviews={data.interviews} go={go} /><AdvicePanel result={data.result} go={go} /></div></div>; }

function FlowView() { return <div className="os-flow-view"><p className="os-overline">YOUR PREP SYSTEM</p><h1>一条完整的准备路径</h1><p>先建立素材，再启动分析；每一次输出都将指向下一项具体行动。</p><div className="os-flow-path">{[["01", "个人资料", "简历、经历、技能与目标方向"], ["02", "目标岗位", "JD、公司背景与岗位要求"], ["03", "岗位分析", "匹配度、风险、场景和题库"], ["04", "面试演练", "笔试、技术面、HR 面与复盘"]].map(([number,title,desc]) => <div key={number}><span>{number}</span><h2>{title}</h2><p>{desc}</p></div>)}</div></div>; }
function StartMenu({ close, go }: { close: () => void; go: (view: View) => void }) { const actions: { icon: ComponentType<{ size?: number }>; title: string; detail: string; view: View }[] = [{ icon: FileText, title: "导入或完善简历", detail: "上传文件、AI 解析或手动编辑", view: "简历" }, { icon: BriefcaseBusiness, title: "添加目标职位", detail: "保存 JD、公司和业务背景", view: "职位" }, { icon: Gauge, title: "创建岗位准备计划", detail: "已有简历与职位时，从这里开始分析", view: "分析" }]; return <div className="os-modal-backdrop" onMouseDown={close}><Card className="os-start-menu" onMouseDown={event => event.stopPropagation()}><button className="os-close" onClick={close}><X size={19} /></button><p>QUICK START</p><h2>从哪里开始准备？</h2><span>每一次岗位分析都会成为一个可恢复、可追踪的准备计划。</span><div>{actions.map(({ icon: Icon, title, detail, view }) => <button key={title} onClick={() => go(view)}><i><Icon size={19} /></i><b>{title}<small>{detail}</small></b><ChevronRight size={17} /></button>)}</div></Card></div>; }

export default function App() { const [view, setView] = useState<View>("总览"); const [flow, setFlow] = useState(false); const [dark, setDark] = useState(false); const [mobileOpen, setMobileOpen] = useState(false); const [startOpen, setStartOpen] = useState(false); const [interviewAnalysisId, setInterviewAnalysisId] = useState(""); const data = useDashboardData(); const go = (next: View) => { setView(next); setFlow(false); setMobileOpen(false); setStartOpen(false); }; const page = useMemo(() => { if (flow) return <FlowView />; if (view === "简历") return <ResumesPage />; if (view === "职位") return <PositionsPage />; if (view === "分析") return <AnalysisPage onReady={setInterviewAnalysisId} />; if (view === "模拟面试") return <InterviewPage activeAnalysis={interviewAnalysisId} />; if (view === "历史") return <HistoryPage />; if (view === "设置") return <SettingsPage />; return <WorkspaceDashboard data={data} go={go} />; }, [view, flow, interviewAnalysisId, data]); const resume = data.resumes[0]; const position = data.positions[0]; const latest = data.analyses[0]; return <main className={cn("os-app", dark && "os-night")}><header className="os-topbar"><div className="os-brand"><button className="os-menu-mobile" onClick={() => setMobileOpen(!mobileOpen)}><Menu size={20} /></button><span>✳</span><b>HireMind</b><i /><small>本地数据 · {data.online ? "已就绪" : "未连接"}</small></div><div className="os-switch"><button className={!flow ? "active" : ""} onClick={() => setFlow(false)}>工作台</button><button className={flow ? "active" : ""} onClick={() => setFlow(true)}>流程</button></div><div className="os-actions"><button className="os-user"><CircleUserRound size={16} />个人工作区 <ChevronDown size={14} /></button><button aria-label="通知"><Bell size={17} /></button><button aria-label="帮助"><CircleHelp size={17} /></button><button aria-label="切换主题" onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button><Button variant="dark" onClick={() => setStartOpen(true)}><Plus size={17} />新建准备</Button></div></header><div className="os-grid"><aside className={cn("os-left", mobileOpen && "show")}><nav>{nav.map(({ label, icon: Icon }) => <button onClick={() => go(label)} key={label} className={cn(view === label && !flow && "active")}><Icon size={20} />{label}</button>)}</nav><div className="os-left-context"><p>当前对象</p><ContextItem icon={FileText} eyebrow="简历" title={resume?.name || "尚未选择简历"} meta={resume ? `更新于 ${displayDate(resume.updated_at)}` : "添加简历，建立资料库"} onClick={() => go("简历")} /><ContextItem icon={BriefcaseBusiness} eyebrow="职位" title={position?.job_title || position?.name || "尚未选择职位"} meta={position?.company_name || "添加目标岗位与 JD"} onClick={() => go("职位")} /></div></aside><section className="os-canvas">{page}</section><aside className="os-right"><h2>当前对象上下文</h2><ContextItem icon={FileText} eyebrow="当前简历" title={resume?.name || "未选择简历"} meta={resume ? `更新于 ${displayDate(resume.updated_at)}` : "添加简历以开始"} onClick={() => go("简历")} /><ContextItem icon={BriefcaseBusiness} eyebrow="当前职位" title={position?.job_title || position?.name || "未选择职位"} meta={position?.company_name || "添加一个目标职位"} onClick={() => go("职位")} /><ContextItem icon={Gauge} eyebrow="最近分析" title={latest?.title || "尚未进行岗位分析"} meta={data.result ? `匹配度 ${data.result.match_analysis.match_score} · 7 个节点` : "分析后生成完整准备报告"} onClick={() => go("分析")} /><ContextItem icon={Target} eyebrow="下一步行动" title={data.result ? "开始模拟面试" : "创建岗位分析"} meta={data.result ? "用报告生成针对性面试计划" : "选择简历和职位开始"} onClick={() => go(data.result ? "模拟面试" : "分析")} /><div className="os-system"><p>系统状态</p><span><i className={data.online ? "ok" : "bad"} />本地数据<em>{data.online ? "正常" : "未连接"}</em></span><span><i className={data.online ? "ok" : "bad"} />分析服务<em>{data.online ? "已就绪" : "等待服务"}</em></span><span><i className={data.result ? "ok" : "idle"} />分析节点<em>{data.result ? "已完成" : "待开始"}</em></span></div></aside></div>{startOpen && <StartMenu close={() => setStartOpen(false)} go={go} />}</main>; }
