import { useEffect, useMemo, useState } from "react";
import { BriefcaseBusiness, Plus, Save, Search, Trash2 } from "lucide-react";
import { api, type Position } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, PageHeader } from "./ResumesPage";

const blank = (): Partial<Position> => ({ name: "未命名职位", company_name: "", company_business_scope: "", job_title: "", job_requirements: "", notes: "" });

export function PositionsPage() {
  const [items, setItems] = useState<Position[]>([]);
  const [current, setCurrent] = useState<Partial<Position> | null>(null);
  const [isNew, setNew] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter(item => `${item.company_name} ${item.job_title} ${item.name}`.toLowerCase().includes(needle)) : items;
  }, [items, query]);
  const jdLength = current?.job_requirements?.trim().length || 0;

  const load = async (selectFirst = false) => {
    const next = (await api.positions()).positions;
    setItems(next);
    if (selectFirst && next[0]) setCurrent((await api.position(next[0].id)).position);
  };
  useEffect(() => { void load(true).catch(error => setMessage(error.message)); }, []);
  const select = async (id: string) => { setNew(false); setCurrent((await api.position(id)).position); setMessage(""); };
  const save = async () => {
    if (!current) return;
    try {
      const result = isNew ? await api.createPosition(current) : await api.updatePosition(current.id!, current);
      setCurrent(result.position); setNew(false); await load(); setMessage("职位已保存，可以直接用于岗位分析");
    } catch (error) { setMessage((error as Error).message); }
  };
  const remove = async () => {
    if (!current?.id || !confirm("确定删除该职位吗？")) return;
    await api.deletePosition(current.id); setCurrent(null); await load(true);
  };
  const set = (key: keyof Position, value: string) => current && setCurrent({ ...current, [key]: value });

  return <div className="module-page">
    <PageHeader title="职位库" detail="沉淀目标岗位、完整 JD 与公司背景，让每次分析都建立在可靠上下文上。" actions={
      <Button onClick={() => { setCurrent(blank()); setNew(true); setMessage(""); }} className="bg-emerald-700 hover:bg-emerald-800"><Plus size={16} />新建职位</Button>
    } />
    <div className="module-grid positions-grid">
      <Card className="list-panel">
        <div className="resource-list-head"><p className="panel-kicker">职位记录 · {items.length}</p><span>{filtered.length} 项</span></div>
        <label className="resource-search"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索公司或岗位" /></label>
        {filtered.map(item => <button onClick={() => void select(item.id)} key={item.id} className={`resource-row ${current?.id === item.id ? "selected" : ""}`}>
          <BriefcaseBusiness size={18} /><span><b>{item.job_title || item.name}</b><small>{item.company_name || "匿名公司"}</small></span>
        </button>)}
        {!filtered.length && <div className="resource-empty">{query ? "没有匹配的职位" : "还没有职位记录"}</div>}
      </Card>
      <Card className="editor-panel">
        {current ? <>
          <div className="editor-title"><div><p className="panel-kicker">{isNew ? "创建岗位档案" : "岗位详情"}</p><input className="title-input" value={current.name || ""} onChange={event => set("name", event.target.value)} /></div>{!isNew && <Button size="sm" variant="ghost" onClick={remove}><Trash2 size={16} /></Button>}</div>
          <div className="editor-insights"><span><b>{jdLength}</b> JD 字符</span><span className={jdLength >= 200 ? "ready" : ""}>{jdLength >= 200 ? "上下文充足" : "建议补充完整 JD"}</span></div>
          <section><h3>岗位身份</h3><div className="field-grid"><label>公司名称<input value={current.company_name || ""} onChange={event => set("company_name", event.target.value)} /></label><label>职位名称<input value={current.job_title || ""} onChange={event => set("job_title", event.target.value)} /></label></div><label className="wide-label">公司业务范围<textarea rows={3} value={current.company_business_scope || ""} onChange={event => set("company_business_scope", event.target.value)} placeholder="产品、客户、商业模式和行业位置" /></label></section>
          <section><div className="section-head"><h3>职位描述（JD）</h3><small>{jdLength} 字符</small></div><label className="wide-label"><textarea rows={13} value={current.job_requirements || ""} onChange={event => set("job_requirements", event.target.value)} placeholder="粘贴职责、能力要求、加分项等完整岗位信息" /></label></section>
          <section><h3>个人备注</h3><label className="wide-label"><textarea rows={3} value={current.notes || ""} onChange={event => set("notes", event.target.value)} placeholder="记录内推人、投递渠道或面试进度" /></label></section>
          <div className="editor-savebar"><span>{message || "更改不会自动保存"}</span><Button onClick={save} className="bg-emerald-700 hover:bg-emerald-800"><Save size={16} />保存职位</Button></div>
        </> : <Empty text="从左侧选择职位，或新建一份岗位档案" />}
      </Card>
    </div>
  </div>;
}
