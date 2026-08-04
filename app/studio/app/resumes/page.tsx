"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { relativeTime, downloadReport } from "@/lib/utils";
import type {
  Resume,
  ResumeData,
  ResumeListItem,
  ResumeTemplate,
  ResumeEducation,
  ResumeExperience,
  ResumeProject,
  ResumeSkill,
} from "@/lib/types";
import ResumePreview from "@/components/ResumePreview";
import FullscreenPreview, { FullscreenButton } from "@/components/FullscreenPreview";

export default function ResumesPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <ResumesPage />
    </Suspense>
  );
}

function ResumesPage() {
  const searchParams = useSearchParams();
  const [list, setList] = useState<ResumeListItem[]>([]);
  const [templates, setTemplates] = useState<Record<string, ResumeTemplate>>({});
  const [current, setCurrent] = useState<Resume | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [exporting, setExporting] = useState<string>("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // 列表容器 ref,用于滚动定位到选中项
  const listRef = useRef<HTMLDivElement>(null);
  // 记录上次已处理的 resumeParam,避免列表刷新时反复跳回参数指定的简历
  const processedParamRef = useRef<string | null>(null);

  useEffect(() => {
    refreshList();
    api.listResumeTemplates().then((r) => setTemplates(r.templates || {})).catch(() => {});
  }, []);

  // 支持 ?resume=<id> 预选(从面试分析溯源跳转过来)
  const resumeParam = searchParams.get("resume");
  useEffect(() => {
    if (list.length === 0) return;

    // 1) 如果 URL 参数变化了(或首次出现),优先选中参数指定的简历
    if (resumeParam && resumeParam !== processedParamRef.current) {
      processedParamRef.current = resumeParam;
      const exists = list.some((r) => r.id === resumeParam);
      if (exists) {
        loadResume(resumeParam);
        return;
      }
    }

    // 2) 如果当前没有选中(或选中的已被删除),默认选第一个
    const currentExists = current && list.some((r) => r.id === current.id);
    if (!currentExists) {
      loadResume(list[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeParam, list]);

  // 选中项变化时滚动到列表中对应位置
  useEffect(() => {
    if (!current || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-resume-id="${current.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [current]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  async function refreshList() {
    try {
      const r = await api.listResumes();
      setList(r.resumes || []);
    } catch {
      setError("加载简历列表失败");
    }
  }

  async function loadResume(id: string) {
    setLoading(true);
    setError("");
    try {
      const r = await api.getResume(id);
      setCurrent(r.resume);
    } catch {
      setError("加载简历失败");
    } finally {
      setLoading(false);
    }
  }

  async function createNew() {
    setSaving(true);
    try {
      const r = await api.createResume({ name: `未命名简历 ${list.length + 1}` });
      setCurrent(r.resume);
      await refreshList();
      setToast("已新建简历");
    } catch {
      setError("新建失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveCurrent() {
    if (!current) return;
    setSaving(true);
    setError("");
    try {
      await api.updateResume(current.id, {
        name: current.name,
        data: current.data,
        template: current.data.template,
      });
      await refreshList();
      setToast("已保存");
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCurrent() {
    if (!current) return;
    if (!confirm(`确认删除「${current.name}」?`)) return;
    try {
      await api.deleteResume(current.id);
      setCurrent(null);
      await refreshList();
      setToast("已删除");
    } catch {
      setError("删除失败");
    }
  }

  async function handleUploadFile(file: File) {
    setParsing(true);
    setError("");
    try {
      const r = await api.uploadParseResume(file);
      if (!r.success || !r.data) {
        setError(r.error || "解析失败");
        return;
      }
      // 新建一份简历,塞入解析结果
      const created = await api.createResume({
        name: file.name.replace(/\.[^.]+$/, ""),
        data: r.data,
        raw_text: r.text,
      });
      setCurrent(created.resume);
      await refreshList();
      setToast("已上传并解析");
    } catch (e) {
      setError("上传解析失败");
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleExport(format: "word" | "pdf") {
    if (!current) return;
    setExporting(format);
    setError("");
    try {
      const r = await api.exportResume(current.id, format, current.data.template);
      if (!r.success || !r.filename) {
        setError(r.error || "导出失败");
        return;
      }
      // 通过 download 接口拉取文件
      const url = api.downloadUrl(r.filename);
      await downloadReport(r.filename, url);
      setToast(`已导出 ${format.toUpperCase()}`);
    } catch {
      setError("导出失败");
    } finally {
      setExporting("");
    }
  }

  function updateData(patch: Partial<ResumeData>) {
    setCurrent((c) => (c ? { ...c, data: { ...c.data, ...patch } } : c));
  }

  function changeTemplate(tpl: string) {
    updateData({ template: tpl });
  }

  async function handleUploadPhoto(file: File) {
    if (!current) return;
    setUploadingPhoto(true);
    setError("");
    try {
      const r = await api.uploadResumePhoto(current.id, file);
      if (!r.success || !r.photo) {
        setError(r.error || "头像上传失败");
        return;
      }
      // 更新当前简历的 photo 字段
      setCurrent((c) =>
        c ? { ...c, data: { ...c.data, basics: { ...c.data.basics, photo: r.photo! } } } : c,
      );
      setToast("头像已上传");
    } catch {
      setError("头像上传失败");
    } finally {
      setUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  function removePhoto() {
    if (!current) return;
    setCurrent((c) =>
      c ? { ...c, data: { ...c.data, basics: { ...c.data.basics, photo: "" } } } : c,
    );
    setToast("已移除头像");
  }

  return (
    <div className="flex h-screen">
      {/* 左侧:简历列表 */}
      <div
        className="w-64 shrink-0 flex flex-col border-r"
        style={{ background: "var(--bg-sidebar)", borderColor: "var(--border)" }}
      >
        <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
          <button
            onClick={createNew}
            disabled={saving}
            className="btn btn-primary w-full"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            新建简历
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={parsing}
            className="btn btn-secondary w-full mt-2"
          >
            {parsing ? "解析中…" : "上传 Word/PDF 解析"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUploadFile(f);
            }}
          />
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUploadPhoto(f);
            }}
          />
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2">
          {list.length === 0 ? (
            <div className="text-[12px] text-stone-400 text-center py-8 px-3">
              还没有简历,点击上方按钮新建或上传
            </div>
          ) : (
            list.map((r) => {
              const active = current?.id === r.id;
              return (
                <button
                  key={r.id}
                  data-resume-id={r.id}
                  onClick={() => loadResume(r.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg mb-1 transition ${
                    active ? "" : "hover:bg-white/60"
                  }`}
                  style={
                    active
                      ? { background: "var(--bg-elevated)", boxShadow: "var(--shadow-sm)" }
                      : undefined
                  }
                >
                  <div className="text-[13px] font-medium text-stone-800 truncate">
                    {r.basics_name || r.name}
                  </div>
                  <div className="text-[11px] text-stone-500 truncate mt-0.5">
                    {r.basics_title || "—"}
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="badge badge-muted">
                      {templates[r.template]?.name || r.template}
                    </span>
                    <span className="text-[10px] text-stone-400">
                      {relativeTime(r.updated_at)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 中间:编辑器 */}
      <div className="w-[420px] shrink-0 flex flex-col border-r" style={{ borderColor: "var(--border)" }}>
        {!current ? (
          <div className="flex-1 flex items-center justify-center text-stone-400 text-[13px]">
            {loading ? "加载中…" : "选择或新建一份简历开始编辑"}
          </div>
        ) : (
          <>
            {/* 顶部:名称 + 操作 */}
            <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
              <input
                value={current.name}
                onChange={(e) => setCurrent({ ...current, name: e.target.value })}
                className="input mb-3 font-medium"
                placeholder="简历名称"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveCurrent}
                  disabled={saving}
                  className="btn btn-primary flex-1"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                <button
                  onClick={() => handleExport("word")}
                  disabled={!!exporting}
                  className="btn btn-secondary"
                >
                  {exporting === "word" ? "…" : "Word"}
                </button>
                <button
                  onClick={() => handleExport("pdf")}
                  disabled={!!exporting}
                  className="btn btn-secondary"
                >
                  {exporting === "pdf" ? "…" : "PDF"}
                </button>
                <button onClick={deleteCurrent} className="btn btn-danger">
                  删除
                </button>
              </div>
              {/* 模板选择 */}
              <div className="mt-3">
                <div className="label">模板风格</div>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(templates).map(([key, t]) => {
                    const active = current.data.template === key;
                    return (
                      <button
                        key={key}
                        onClick={() => changeTemplate(key)}
                        className="px-2 py-2 rounded-lg border text-[12px] transition"
                        style={{
                          borderColor: active ? t.accent : "var(--border)",
                          background: active ? `${t.accent}10` : "var(--bg-elevated)",
                          color: active ? t.accent : "var(--fg-muted)",
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 编辑表单 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <BasicsEditor
                data={current.data}
                onChange={(patch) => updateData({ basics: { ...current.data.basics, ...patch } })}
                onUploadPhoto={() => photoInputRef.current?.click()}
                onRemovePhoto={removePhoto}
                uploadingPhoto={uploadingPhoto}
                photoInputRef={photoInputRef}
              />
              <ArrayEditor<ResumeEducation>
                title="教育经历"
                items={current.data.education}
                onChange={(education) => updateData({ education })}
                newItem={() => ({
                  school: "", major: "", degree: "",
                  start: "", end: "", gpa: "", description: "",
                })}
                renderItem={(item, update) => (
                  <EducationFields item={item} update={update} />
                )}
              />
              <ArrayEditor<ResumeExperience>
                title="工作经历"
                items={current.data.experiences}
                onChange={(experiences) => updateData({ experiences })}
                newItem={() => ({
                  company: "", position: "",
                  start: "", end: "", description: "",
                })}
                renderItem={(item, update) => (
                  <ExperienceFields item={item} update={update} />
                )}
              />
              <ArrayEditor<ResumeProject>
                title="项目经历"
                items={current.data.projects}
                onChange={(projects) => updateData({ projects })}
                newItem={() => ({
                  name: "", role: "",
                  start: "", end: "", description: "",
                  tech_stack: [],
                })}
                renderItem={(item, update) => (
                  <ProjectFields item={item} update={update} />
                )}
              />
              <ArrayEditor<ResumeSkill>
                title="技能"
                items={current.data.skills}
                onChange={(skills) => updateData({ skills })}
                newItem={() => ({ category: "", items: [] })}
                renderItem={(item, update) => (
                  <SkillFields item={item} update={update} />
                )}
              />
            </div>
          </>
        )}
      </div>

      {/* 右侧:实时预览 */}
      <div className="flex-1 min-w-0 overflow-y-auto" style={{ background: "var(--bg-muted)" }}>
        {current ? (
          <div className="p-8">
            {/* 工具条:全屏按钮 */}
            <div className="mx-auto max-w-[820px] flex justify-end mb-2">
              <FullscreenButton onClick={() => setFullscreen(true)} />
            </div>
            <div
              className="mx-auto max-w-[820px] shadow-lg rounded-lg overflow-hidden fade-in"
              style={{ background: "#fff" }}
            >
              <ResumePreview data={current.data} template={current.data.template} />
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-stone-400 text-[13px]">
            预览区
          </div>
        )}
      </div>

      {/* 全屏预览覆盖层 */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={current?.name}
        subtitle="预览模式 · 按 Esc 退出"
        maxWidth={820}
      >
        {current && (
          <div className="shadow-lg rounded-lg overflow-hidden" style={{ background: "#fff" }}>
            <ResumePreview data={current.data} template={current.data.template} />
          </div>
        )}
      </FullscreenPreview>

      {/* Toast / Error */}
      {error && (
        <div
          className="fixed bottom-6 right-6 px-4 py-3 rounded-lg text-[13px] fade-in"
          style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid var(--danger)" }}
        >
          {error}
          <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setError("")}>×</button>
        </div>
      )}
      {toast && !error && (
        <div
          className="fixed bottom-6 right-6 px-4 py-3 rounded-lg text-[13px] fade-in"
          style={{ background: "var(--success-soft)", color: "var(--success)", border: "1px solid var(--success)" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ── 基本信息 ──
function BasicsEditor({
  data,
  onChange,
  onUploadPhoto,
  onRemovePhoto,
  uploadingPhoto,
  photoInputRef,
}: {
  data: ResumeData;
  onChange: (patch: Partial<ResumeData["basics"]>) => void;
  onUploadPhoto: () => void;
  onRemovePhoto: () => void;
  uploadingPhoto: boolean;
  photoInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const b = data.basics;
  const photoUrl = api.assetUrl(b.photo || "");
  return (
    <div>
      <div className="section-title">基本信息</div>

      {/* 头像上传 */}
      <div className="flex items-center gap-4 mb-4 p-3 rounded-lg" style={{ background: "var(--bg-elevated)" }}>
        <div className="relative shrink-0">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt="头像"
              className="w-16 h-16 rounded-full object-cover border-2"
              style={{ borderColor: "var(--accent)" }}
            />
          ) : (
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-stone-400"
              style={{ background: "var(--bg-muted)" }}
            >
              <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-stone-500 mb-1.5">职业照 / 头像</div>
          <div className="flex items-center gap-2">
            <button
              onClick={onUploadPhoto}
              disabled={uploadingPhoto}
              className="btn btn-secondary text-[12px]"
            >
              {uploadingPhoto ? "上传中…" : photoUrl ? "更换" : "上传"}
            </button>
            {photoUrl && (
              <button onClick={onRemovePhoto} className="btn btn-ghost text-[12px]">
                移除
              </button>
            )}
          </div>
          <div className="text-[11px] text-stone-400 mt-1">建议 1:1 方图,5MB 以内</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">姓名</label>
          <input
            className="input"
            value={b.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="张三"
          />
        </div>
        <div>
          <label className="label">职位头衔</label>
          <input
            className="input"
            value={b.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="高级产品经理"
          />
        </div>
        <div>
          <label className="label">电话</label>
          <input
            className="input"
            value={b.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="138..."
          />
        </div>
        <div>
          <label className="label">邮箱</label>
          <input
            className="input"
            value={b.email}
            onChange={(e) => onChange({ email: e.target.value })}
            placeholder="you@example.com"
          />
        </div>
        <div className="col-span-2">
          <label className="label">所在地</label>
          <input
            className="input"
            value={b.location}
            onChange={(e) => onChange({ location: e.target.value })}
            placeholder="上海"
          />
        </div>
        <div className="col-span-2">
          <label className="label">个人简介</label>
          <textarea
            className="input"
            rows={3}
            value={b.summary}
            onChange={(e) => onChange({ summary: e.target.value })}
            placeholder="一句话介绍你的核心优势与方向"
          />
        </div>
      </div>
    </div>
  );
}

// ── 数组项通用编辑器 ──
function ArrayEditor<T>({
  title,
  items,
  onChange,
  newItem,
  renderItem,
}: {
  title: string;
  items: T[];
  onChange: (items: T[]) => void;
  newItem: () => T;
  renderItem: (item: T, update: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  function update(i: number, patch: Partial<T>) {
    const next = [...items];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...items, newItem()]);
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="section-title mb-0">{title}</div>
        <button onClick={add} className="btn btn-ghost text-[12px]">
          + 添加
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-[12px] text-stone-400 italic py-2">暂无,点击添加</div>
      ) : (
        <div className="space-y-3">
          {items.map((item, i) => (
            <div
              key={i}
              className="p-3 rounded-lg border relative"
              style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
            >
              <button
                onClick={() => remove(i)}
                className="absolute top-2 right-2 w-6 h-6 rounded text-stone-400 hover:bg-red-50 hover:text-red-600 text-[14px]"
                title="删除"
              >
                ×
              </button>
              {renderItem(item, (patch) => update(i, patch))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EducationFields({
  item,
  update,
}: {
  item: ResumeEducation;
  update: (patch: Partial<ResumeEducation>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pr-6">
      <input className="input" placeholder="学校" value={item.school}
        onChange={(e) => update({ school: e.target.value })} />
      <input className="input" placeholder="专业" value={item.major}
        onChange={(e) => update({ major: e.target.value })} />
      <input className="input" placeholder="学位" value={item.degree}
        onChange={(e) => update({ degree: e.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <input className="input" placeholder="开始" value={item.start}
          onChange={(e) => update({ start: e.target.value })} />
        <input className="input" placeholder="结束" value={item.end}
          onChange={(e) => update({ end: e.target.value })} />
      </div>
      <textarea className="input col-span-2" rows={2} placeholder="补充说明(可选)" value={item.description}
        onChange={(e) => update({ description: e.target.value })} />
    </div>
  );
}

function ExperienceFields({
  item,
  update,
}: {
  item: ResumeExperience;
  update: (patch: Partial<ResumeExperience>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pr-6">
      <input className="input" placeholder="公司" value={item.company}
        onChange={(e) => update({ company: e.target.value })} />
      <input className="input" placeholder="职位" value={item.position}
        onChange={(e) => update({ position: e.target.value })} />
      <input className="input" placeholder="开始" value={item.start}
        onChange={(e) => update({ start: e.target.value })} />
      <input className="input" placeholder="结束" value={item.end}
        onChange={(e) => update({ end: e.target.value })} />
      <textarea className="input col-span-2" rows={3} placeholder="工作内容与成果" value={item.description}
        onChange={(e) => update({ description: e.target.value })} />
    </div>
  );
}

function ProjectFields({
  item,
  update,
}: {
  item: ResumeProject;
  update: (patch: Partial<ResumeProject>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pr-6">
      <input className="input" placeholder="项目名" value={item.name}
        onChange={(e) => update({ name: e.target.value })} />
      <input className="input" placeholder="角色" value={item.role}
        onChange={(e) => update({ role: e.target.value })} />
      <input className="input" placeholder="开始" value={item.start}
        onChange={(e) => update({ start: e.target.value })} />
      <input className="input" placeholder="结束" value={item.end}
        onChange={(e) => update({ end: e.target.value })} />
      <textarea className="input col-span-2" rows={2} placeholder="项目描述与成果" value={item.description}
        onChange={(e) => update({ description: e.target.value })} />
      <input
        className="input col-span-2"
        placeholder="技术栈(逗号分隔)"
        value={item.tech_stack.join(", ")}
        onChange={(e) =>
          update({
            tech_stack: e.target.value
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
    </div>
  );
}

function SkillFields({
  item,
  update,
}: {
  item: ResumeSkill;
  update: (patch: Partial<ResumeSkill>) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 pr-6">
      <input className="input" placeholder="分类(如:编程语言)" value={item.category}
        onChange={(e) => update({ category: e.target.value })} />
      <input
        className="input"
        placeholder="技能项(逗号分隔)"
        value={item.items.join(", ")}
        onChange={(e) =>
          update({
            items: e.target.value
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
    </div>
  );
}
