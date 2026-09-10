"use client"; // 客户端组件:需要访问浏览器 API、sessionStorage、URL 参数与文件上传

// 引入 React hooks、Next.js 路由能力与 API 客户端
import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { relativeTime, downloadReport } from "@/lib/utils";
// 引入简历相关类型
import type {
  Resume, // 简历完整对象
  ResumeData, // 简历数据
  ResumeListItem, // 简历列表项
  ResumeTemplate, // 简历模板
  ResumeEducation, // 教育经历
  ResumeExperience, // 工作经历
  ResumeProject, // 项目经历
  ResumeSkill, // 技能
} from "@/lib/types";
// 引入预览与全屏组件
import ResumePreview from "@/components/ResumePreview";
import FullscreenPreview, { FullscreenButton } from "@/components/FullscreenPreview";

/**
 * 页面包装组件:用 Suspense 包裹。
 * useSearchParams 在 App Router 中需要 Suspense 边界,否则构建报错。
 */
export default function ResumesPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <ResumesPage />
    </Suspense>
  );
}

/**
 * 简历编辑器页面:三栏布局。
 * 左栏:简历列表(新建/上传解析)
 * 中栏:结构化编辑表单(基本信息/教育/工作/项目/技能)
 * 右栏:实时预览 + 全屏预览
 *
 * 功能:
 * - 支持 ?resume=<id> URL 预选(从面试分析溯源跳转)
 * - 上传 Word/PDF 解析为结构化简历(LLM 提取)
 * - 三套模板切换(classic/modern/minimal)
 * - 一键导出 Word/PDF、上传头像
 */
function ResumesPage() {
  const searchParams = useSearchParams(); // 读取 URL 查询参数(?resume=)
  const [list, setList] = useState<ResumeListItem[]>([]); // 简历列表
  const [templates, setTemplates] = useState<Record<string, ResumeTemplate>>({}); // 模板元信息
  const [current, setCurrent] = useState<Resume | null>(null); // 当前编辑的简历
  const [loading, setLoading] = useState(false); // 加载中
  const [saving, setSaving] = useState(false); // 保存中
  const [parsing, setParsing] = useState(false); // 上传解析中
  const [exporting, setExporting] = useState<string>(""); // 导出中("word"/"pdf"/空)
  const [uploadingPhoto, setUploadingPhoto] = useState(false); // 头像上传中
  const [error, setError] = useState(""); // 错误提示
  const [toast, setToast] = useState(""); // 成功提示
  const [fullscreen, setFullscreen] = useState(false); // 全屏预览开关
  const fileInputRef = useRef<HTMLInputElement>(null); // 简历文件上传 input ref
  const photoInputRef = useRef<HTMLInputElement>(null); // 头像上传 input ref
  // 列表容器 ref,用于滚动定位到选中项
  const listRef = useRef<HTMLDivElement>(null);
  // 记录上次已处理的 resumeParam,避免列表刷新时反复跳回参数指定的简历
  const processedParamRef = useRef<string | null>(null);

  // 挂载时:加载简历列表 + 模板元信息
  useEffect(() => {
    refreshList();
    api.listResumeTemplates().then((r) => setTemplates(r.templates || {})).catch(() => {});
  }, []);

  // ── 支持 ?resume=<id> 预选(从面试分析溯源跳转过来) ──
  const resumeParam = searchParams.get("resume");
  useEffect(() => {
    if (list.length === 0) return; // 列表未加载完先不处理

    // 1) 如果 URL 参数变化了(或首次出现),优先选中参数指定的简历
    if (resumeParam && resumeParam !== processedParamRef.current) {
      processedParamRef.current = resumeParam; // 标记已处理
      const exists = list.some((r) => r.id === resumeParam); // 参数简历是否在列表中
      if (exists) {
        loadResume(resumeParam); // 存在则加载它
        return;
      }
    }

    // 2) 如果当前没有选中(或选中的已被删除),默认选第一个
    const currentExists = current && list.some((r) => r.id === current.id);
    if (!currentExists) {
      loadResume(list[0].id); // 默认选中第一份简历
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeParam, list]);

  // ── 选中项变化时滚动到列表中对应位置 ──
  useEffect(() => {
    if (!current || !listRef.current) return; // 无选中或无容器则跳过
    // 通过 data-resume-id 属性定位列表项 DOM
    const el = listRef.current.querySelector(`[data-resume-id="${current.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" }); // 平滑滚动到可见区域
    }
  }, [current]); // 依赖当前选中项

  // ── toast 自动消失:2.2 秒后清空 ──
  useEffect(() => {
    if (!toast) return; // 无提示不设定时器
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t); // 清理定时器
  }, [toast]);

  /** 刷新简历列表。 */
  async function refreshList() {
    try {
      const r = await api.listResumes();
      setList(r.resumes || []);
    } catch {
      setError("加载简历列表失败");
    }
  }

  /** 加载指定简历的完整详情,并同步 URL 与 sessionStorage。 */
  async function loadResume(id: string) {
    setLoading(true); // 进入加载态
    setError(""); // 清空错误
    try {
      const r = await api.getResume(id); // 拉取简历详情
      setCurrent(r.resume); // 更新当前编辑对象
      // 同步 URL 参数,让 Ask 助手能定位到当前查看的简历
      // 用 replaceState 避免触发 Next.js 路由重新渲染/滚动
      const url = new URL(window.location.href);
      if (url.searchParams.get("resume") !== id) {
        url.searchParams.set("resume", id); // 设置 resume 参数
        window.history.replaceState(null, "", url); // 静默替换地址栏
      }
      // 写入 sessionStorage 供 Ask 助手读取当前查看的简历信息
      try {
        sessionStorage.setItem(
          "hiremind:resume-state-v1",
          JSON.stringify({
            resumeId: id, // 简历 ID
            name: r.resume.name, // 简历名
            basicsName: r.resume.data?.basics?.name || "", // 姓名
            title: r.resume.data?.basics?.title || "", // 求职意向
          }),
        );
      } catch {
        // sessionStorage 写入失败不影响主流程
      }
    } catch {
      setError("加载简历失败");
    } finally {
      setLoading(false); // 无论成败退出加载态
    }
  }

  /** 新建一份空白简历(自动命名"未命名简历 N")。 */
  async function createNew() {
    setSaving(true); // 进入保存态(禁用按钮)
    try {
      // 命名:未命名简历 + 当前列表数量 + 1
      const r = await api.createResume({ name: `未命名简历 ${list.length + 1}` });
      setCurrent(r.resume); // 选中新简历
      await refreshList(); // 刷新列表
      setToast("已新建简历");
    } catch {
      setError("新建失败");
    } finally {
      setSaving(false);
    }
  }

  /** 保存当前简历(名称 + 结构化数据 + 模板)。 */
  async function saveCurrent() {
    if (!current) return; // 无当前简历则忽略
    setSaving(true); // 进入保存态
    setError(""); // 清空错误
    try {
      await api.updateResume(current.id, {
        name: current.name, // 简历名称
        data: current.data, // 结构化数据
        template: current.data.template, // 模板标识
      });
      await refreshList(); // 刷新列表(更新名称/时间)
      setToast("已保存");
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false);
    }
  }

  /** 删除当前简历:先 confirm 确认,再调用删除接口。 */
  async function deleteCurrent() {
    if (!current) return; // 无当前简历则忽略
    if (!confirm(`确认删除「${current.name}」?`)) return; // 用户取消
    try {
      await api.deleteResume(current.id); // 调用删除接口
      setCurrent(null); // 清除当前编辑
      await refreshList(); // 刷新列表
      setToast("已删除");
    } catch {
      setError("删除失败");
    }
  }

  /** 上传简历文件并让 LLM 解析为结构化数据,自动新建简历。 */
  async function handleUploadFile(file: File) {
    setParsing(true); // 进入解析态
    setError(""); // 清空错误
    try {
      const r = await api.uploadParseResume(file); // 上传并解析
      if (!r.success || !r.data) {
        setError(r.error || "解析失败"); // 解析失败展示错误
        return;
      }
      // 新建一份简历,塞入解析结果(文件名去掉扩展名作为简历名)
      const created = await api.createResume({
        name: file.name.replace(/\.[^.]+$/, ""), // 去掉扩展名
        data: r.data, // 结构化数据
        raw_text: r.text, // 原始文本(溯源用)
      });
      setCurrent(created.resume); // 选中解析出的简历
      await refreshList(); // 刷新列表
      setToast("已上传并解析");
    } catch (e) {
      setError("上传解析失败");
    } finally {
      setParsing(false); // 无论成败退出解析态
      if (fileInputRef.current) fileInputRef.current.value = ""; // 清空文件 input(允许重复选同一文件)
    }
  }

  /** 导出当前简历为 Word 或 PDF。 */
  async function handleExport(format: "word" | "pdf") {
    if (!current) return; // 无当前简历则忽略
    setExporting(format); // 标记导出中(按钮显示"…")
    setError(""); // 清空错误
    try {
      // 请求后端生成文件(按当前模板渲染)
      const r = await api.exportResume(current.id, format, current.data.template);
      if (!r.success || !r.filename) {
        setError(r.error || "导出失败");
        return;
      }
      // 通过 download 接口拉取文件并触发浏览器下载
      const url = api.downloadUrl(r.filename); // 拼接下载 URL
      await downloadReport(r.filename, url); // 下载(失败回退新窗口)
      setToast(`已导出 ${format.toUpperCase()}`);
    } catch {
      setError("导出失败");
    } finally {
      setExporting(""); // 清除导出标记
    }
  }

  /** 局部更新当前简历的 data 字段(合并式更新)。 */
  function updateData(patch: Partial<ResumeData>) {
    setCurrent((c) => (c ? { ...c, data: { ...c.data, ...patch } } : c));
  }

  /** 切换简历模板(写入 data.template)。 */
  function changeTemplate(tpl: string) {
    updateData({ template: tpl });
  }

  /** 上传头像照片:上传成功后更新当前简历的 photo 字段。 */
  async function handleUploadPhoto(file: File) {
    if (!current) return; // 无当前简历则忽略
    setUploadingPhoto(true); // 进入上传态
    setError(""); // 清空错误
    try {
      const r = await api.uploadResumePhoto(current.id, file); // 上传头像
      if (!r.success || !r.photo) {
        setError(r.error || "头像上传失败");
        return;
      }
      // 更新当前简历的 photo 字段(immutable 更新嵌套对象)
      setCurrent((c) =>
        c ? { ...c, data: { ...c.data, basics: { ...c.data.basics, photo: r.photo! } } } : c,
      );
      setToast("头像已上传");
    } catch {
      setError("头像上传失败");
    } finally {
      setUploadingPhoto(false); // 退出上传态
      if (photoInputRef.current) photoInputRef.current.value = ""; // 清空文件 input
    }
  }

  /** 移除头像:把 photo 字段置空。 */
  function removePhoto() {
    if (!current) return;
    setCurrent((c) =>
      c ? { ...c, data: { ...c.data, basics: { ...c.data.basics, photo: "" } } } : c,
    );
    setToast("已移除头像");
  }

  return (
    // 页面布局:三栏横向,高度铺满视口
    <div className="flex h-screen">
      {/* ═══ 左栏:简历列表 ═══ */}
      <div
        className="w-64 shrink-0 flex flex-col border-r"
        style={{ background: "var(--bg-sidebar)", borderColor: "var(--border)" }}
      >
        {/* 操作区:新建 + 上传解析 */}
        <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
          {/* 新建简历按钮 */}
          <button
            onClick={createNew}
            disabled={saving} // 保存中禁用
            className="btn btn-primary w-full"
          >
            {/* 加号图标 */}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            新建简历
          </button>
          {/* 上传解析按钮:触发隐藏的文件 input */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={parsing} // 解析中禁用
            className="btn btn-secondary w-full mt-2"
          >
            {parsing ? "解析中…" : "上传 Word/PDF 解析"}
          </button>
          {/* 隐藏的文件 input:接受 PDF/Word/TXT/Markdown */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]; // 取第一个文件
              if (f) handleUploadFile(f); // 触发上传解析
            }}
          />
          {/* 隐藏的头像上传 input(由 BasicsEditor 内的按钮触发) */}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUploadPhoto(f); // 触发头像上传
            }}
          />
        </div>
        {/* 简历卡片列表(可滚动) */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2">
          {/* 空状态 */}
          {list.length === 0 ? (
            <div className="text-[12px] text-stone-400 text-center py-8 px-3">
              还没有简历,点击上方按钮新建或上传
            </div>
          ) : (
            // 简历卡片:点击加载
            list.map((r) => {
              const active = current?.id === r.id; // 是否当前选中
              return (
                <button
                  key={r.id}
                  data-resume-id={r.id} // 供滚动定位使用
                  onClick={() => loadResume(r.id)} // 点击加载详情
                  className={`w-full text-left px-3 py-2.5 rounded-lg mb-1 transition ${
                    active ? "" : "hover:bg-white/60" // 未选中项 hover 提亮
                  }`}
                  style={
                    active
                      ? { background: "var(--bg-elevated)", boxShadow: "var(--shadow-sm)" } // 选中:白底 + 轻阴影
                      : undefined
                  }
                >
                  {/* 姓名(优先 basics_name,否则简历名) */}
                  <div className="text-[13px] font-medium text-stone-800 truncate">
                    {r.basics_name || r.name}
                  </div>
                  {/* 求职意向 */}
                  <div className="text-[11px] text-stone-500 truncate mt-0.5">
                    {r.basics_title || "—"}
                  </div>
                  {/* 底部行:模板徽章 + 更新时间 */}
                  <div className="flex items-center justify-between mt-1">
                    {/* 模板名(优先模板元信息,否则原始标识) */}
                    <span className="badge badge-muted">
                      {templates[r.template]?.name || r.template}
                    </span>
                    {/* 相对更新时间 */}
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

      {/* ═══ 中栏:编辑器 ═══ */}
      <div className="w-[420px] shrink-0 flex flex-col border-r" style={{ borderColor: "var(--border)" }}>
        {/* 未选中简历:占位提示 */}
        {!current ? (
          <div className="flex-1 flex items-center justify-center text-stone-400 text-[13px]">
            {loading ? "加载中…" : "选择或新建一份简历开始编辑"}
          </div>
        ) : (
          <>
            {/* ── 顶部:名称输入 + 操作按钮 + 模板选择 ── */}
            <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
              {/* 简历名称输入框 */}
              <input
                value={current.name}
                onChange={(e) => setCurrent({ ...current, name: e.target.value })}
                className="input mb-3 font-medium"
                placeholder="简历名称"
              />
              {/* 操作按钮行:保存 / 导出 Word / 导出 PDF / 删除 */}
              <div className="flex items-center gap-2">
                {/* 保存按钮 */}
                <button
                  onClick={saveCurrent}
                  disabled={saving}
                  className="btn btn-primary flex-1"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                {/* 导出 Word */}
                <button
                  onClick={() => handleExport("word")}
                  disabled={!!exporting} // 导出进行中禁用
                  className="btn btn-secondary"
                >
                  {exporting === "word" ? "…" : "Word"} {/* 导出中显示省略号 */}
                </button>
                {/* 导出 PDF */}
                <button
                  onClick={() => handleExport("pdf")}
                  disabled={!!exporting}
                  className="btn btn-secondary"
                >
                  {exporting === "pdf" ? "…" : "PDF"}
                </button>
                {/* 删除按钮 */}
                <button onClick={deleteCurrent} className="btn btn-danger">
                  删除
                </button>
              </div>
              {/* 模板选择 */}
              <div className="mt-3">
                <div className="label">模板风格</div>
                {/* 三列:三套模板按钮 */}
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(templates).map(([key, t]) => {
                    const active = current.data.template === key; // 是否当前模板
                    return (
                      <button
                        key={key}
                        onClick={() => changeTemplate(key)} // 切换模板
                        className="px-2 py-2 rounded-lg border text-[12px] transition"
                        style={{
                          // 选中:模板强调色描边 + 浅底 + 强调色文字 + 加粗
                          borderColor: active ? t.accent : "var(--border)",
                          background: active ? `${t.accent}10` : "var(--bg-elevated)",
                          color: active ? t.accent : "var(--fg-muted)",
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {t.name} {/* 模板名 */}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* ── 编辑表单(可滚动) ── */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              {/* 基本信息编辑器 */}
              <BasicsEditor
                data={current.data}
                onChange={(patch) => updateData({ basics: { ...current.data.basics, ...patch } })}
                onUploadPhoto={() => photoInputRef.current?.click()} // 触发隐藏头像 input
                onRemovePhoto={removePhoto}
                uploadingPhoto={uploadingPhoto}
                photoInputRef={photoInputRef}
              />
              {/* 教育经历列表编辑器 */}
              <ArrayEditor<ResumeEducation>
                title="教育经历"
                items={current.data.education}
                onChange={(education) => updateData({ education })}
                newItem={() => ({
                  school: "", major: "", degree: "", // 学校/专业/学位
                  start: "", end: "", gpa: "", description: "", // 时间/绩点/描述
                })}
                renderItem={(item, update) => (
                  <EducationFields item={item} update={update} /> // 教育字段表单
                )}
              />
              {/* 工作经历列表编辑器 */}
              <ArrayEditor<ResumeExperience>
                title="工作经历"
                items={current.data.experiences}
                onChange={(experiences) => updateData({ experiences })}
                newItem={() => ({
                  company: "", position: "", // 公司/职位
                  start: "", end: "", description: "", // 时间/描述
                })}
                renderItem={(item, update) => (
                  <ExperienceFields item={item} update={update} /> // 工作字段表单
                )}
              />
              {/* 项目经历列表编辑器 */}
              <ArrayEditor<ResumeProject>
                title="项目经历"
                items={current.data.projects}
                onChange={(projects) => updateData({ projects })}
                newItem={() => ({
                  name: "", role: "", // 项目名/角色
                  start: "", end: "", description: "", // 时间/描述
                  tech_stack: [], // 技术栈(空数组)
                })}
                renderItem={(item, update) => (
                  <ProjectFields item={item} update={update} /> // 项目字段表单
                )}
              />
              {/* 技能列表编辑器 */}
              <ArrayEditor<ResumeSkill>
                title="技能"
                items={current.data.skills}
                onChange={(skills) => updateData({ skills })}
                newItem={() => ({ category: "", items: [] })} // 分类 + 空技能项
                renderItem={(item, update) => (
                  <SkillFields item={item} update={update} /> // 技能字段表单
                )}
              />
            </div>
          </>
        )}
      </div>

      {/* ═══ 右栏:实时预览 ═══ */}
      <div className="flex-1 min-w-0 overflow-y-auto" style={{ background: "var(--bg-muted)" }}>
        {current ? (
          <div className="p-8">
            {/* 工具条:全屏按钮(右上) */}
            <div className="mx-auto max-w-[820px] flex justify-end mb-2">
              <FullscreenButton onClick={() => setFullscreen(true)} />
            </div>
            {/* 预览卡片:白底 + 阴影,内部渲染三套模板 */}
            <div
              className="mx-auto max-w-[820px] shadow-lg rounded-lg overflow-hidden fade-in"
              style={{ background: "#fff" }}
            >
              <ResumePreview data={current.data} template={current.data.template} />
            </div>
          </div>
        ) : (
          // 无选中:预览区占位
          <div className="h-full flex items-center justify-center text-stone-400 text-[13px]">
            预览区
          </div>
        )}
      </div>

      {/* ═══ 全屏预览覆盖层 ═══ */}
      <FullscreenPreview
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={current?.name} // 标题:简历名
        subtitle="预览模式 · 按 Esc 退出"
        maxWidth={820}
      >
        {/* 全屏内容:同预览卡片 */}
        {current && (
          <div className="shadow-lg rounded-lg overflow-hidden" style={{ background: "#fff" }}>
            <ResumePreview data={current.data} template={current.data.template} />
          </div>
        )}
      </FullscreenPreview>

      {/* ═══ Toast / Error 浮层 ═══ */}
      {/* 错误提示(可关闭) */}
      {error && (
        <div
          className="fixed bottom-6 right-6 px-4 py-3 rounded-lg text-[13px] fade-in"
          style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid var(--danger)" }}
        >
          {error}
          {/* 关闭按钮 */}
          <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setError("")}>×</button>
        </div>
      )}
      {/* 成功提示(错误存在时不重复显示) */}
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

// ═══════════════════════ 基本信息编辑器 ═══════════════════════

/**
 * 基本信息编辑区:头像上传 + 姓名/头衔/电话/邮箱/所在地/简介。
 * @param data - 当前简历数据
 * @param onChange - basics 字段变更回调
 * @param onUploadPhoto - 触发头像上传(打开文件选择)
 * @param onRemovePhoto - 移除头像
 * @param uploadingPhoto - 是否正在上传头像
 * @param photoInputRef - 头像文件 input 的 ref(用于点击触发)
 */
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
  const b = data.basics; // 解构基本信息
  const photoUrl = api.assetUrl(b.photo || ""); // 拼接头像完整 URL
  return (
    <div>
      {/* 区块标题 */}
      <div className="section-title">基本信息</div>

      {/* ── 头像上传区 ── */}
      <div className="flex items-center gap-4 mb-4 p-3 rounded-lg" style={{ background: "var(--bg-elevated)" }}>
        {/* 头像显示:有头像显示图片,否则显示人形占位图标 */}
        <div className="relative shrink-0">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt="头像"
              className="w-16 h-16 rounded-full object-cover border-2"
              style={{ borderColor: "var(--accent)" }} // 橙色边框
            />
          ) : (
            // 占位:人形剪影图标
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
          {/* 标题 */}
          <div className="text-[12px] text-stone-500 mb-1.5">职业照 / 头像</div>
          {/* 操作按钮:上传/更换 + 移除 */}
          <div className="flex items-center gap-2">
            <button
              onClick={onUploadPhoto} // 触发文件选择
              disabled={uploadingPhoto}
              className="btn btn-secondary text-[12px]"
            >
              {uploadingPhoto ? "上传中…" : photoUrl ? "更换" : "上传"}
            </button>
            {/* 有头像时显示移除按钮 */}
            {photoUrl && (
              <button onClick={onRemovePhoto} className="btn btn-ghost text-[12px]">
                移除
              </button>
            )}
          </div>
          {/* 提示文案 */}
          <div className="text-[11px] text-stone-400 mt-1">建议 1:1 方图,5MB 以内</div>
        </div>
      </div>

      {/* ── 基本信息表单:双列网格 ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* 姓名 */}
        <div>
          <label className="label">姓名</label>
          <input
            className="input"
            value={b.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="张三"
          />
        </div>
        {/* 职位头衔 */}
        <div>
          <label className="label">职位头衔</label>
          <input
            className="input"
            value={b.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="高级产品经理"
          />
        </div>
        {/* 电话 */}
        <div>
          <label className="label">电话</label>
          <input
            className="input"
            value={b.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="138..."
          />
        </div>
        {/* 邮箱 */}
        <div>
          <label className="label">邮箱</label>
          <input
            className="input"
            value={b.email}
            onChange={(e) => onChange({ email: e.target.value })}
            placeholder="you@example.com"
          />
        </div>
        {/* 所在地(跨两列) */}
        <div className="col-span-2">
          <label className="label">所在地</label>
          <input
            className="input"
            value={b.location}
            onChange={(e) => onChange({ location: e.target.value })}
            placeholder="上海"
          />
        </div>
        {/* 个人简介(跨两列) */}
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

// ═══════════════════════ 数组项通用编辑器 ═══════════════════════

/**
 * 通用数组编辑器:管理任意类型的列表项(教育/工作/项目/技能)。
 * 提供「添加 / 删除 / 逐项更新」能力,通过泛型 T 复用。
 * @param title - 区块标题
 * @param items - 当前数组
 * @param onChange - 数组整体变更回调
 * @param newItem - 生成新空项的函数
 * @param renderItem - 渲染单项表单的函数(接收 item 与更新函数)
 */
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
  /** 更新指定下标的项(合并式更新)。 */
  function update(i: number, patch: Partial<T>) {
    const next = [...items]; // 复制数组(immutable)
    next[i] = { ...next[i], ...patch }; // 合并更新目标项
    onChange(next); // 回传新数组
  }
  /** 删除指定下标的项。 */
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i)); // 过滤掉目标下标
  }
  /** 追加一个新空项。 */
  function add() {
    onChange([...items, newItem()]); // 展开旧数组 + 追加新项
  }
  return (
    <div>
      {/* 标题行:标题 + 添加按钮 */}
      <div className="flex items-center justify-between mb-3">
        <div className="section-title mb-0">{title}</div>
        <button onClick={add} className="btn btn-ghost text-[12px]">
          + 添加
        </button>
      </div>
      {/* 空态提示 */}
      {items.length === 0 ? (
        <div className="text-[12px] text-stone-400 italic py-2">暂无,点击添加</div>
      ) : (
        // 列表项卡片
        <div className="space-y-3">
          {items.map((item, i) => (
            <div
              key={i}
              className="p-3 rounded-lg border relative"
              style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
            >
              {/* 删除按钮(右上角悬浮) */}
              <button
                onClick={() => remove(i)}
                className="absolute top-2 right-2 w-6 h-6 rounded text-stone-400 hover:bg-red-50 hover:text-red-600 text-[14px]"
                title="删除"
              >
                ×
              </button>
              {/* 渲染单项表单:传入更新函数 */}
              {renderItem(item, (patch) => update(i, patch))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════ 各类型字段表单 ═══════════════════════

/** 教育经历字段表单(学校/专业/学位/时间/描述)。 */
function EducationFields({
  item,
  update,
}: {
  item: ResumeEducation;
  update: (patch: Partial<ResumeEducation>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pr-6">
      {/* 学校 */}
      <input className="input" placeholder="学校" value={item.school}
        onChange={(e) => update({ school: e.target.value })} />
      {/* 专业 */}
      <input className="input" placeholder="专业" value={item.major}
        onChange={(e) => update({ major: e.target.value })} />
      {/* 学位 */}
      <input className="input" placeholder="学位" value={item.degree}
        onChange={(e) => update({ degree: e.target.value })} />
      {/* 起止时间(双列) */}
      <div className="grid grid-cols-2 gap-2">
        <input className="input" placeholder="开始" value={item.start}
          onChange={(e) => update({ start: e.target.value })} />
        <input className="input" placeholder="结束" value={item.end}
          onChange={(e) => update({ end: e.target.value })} />
      </div>
      {/* 补充说明(跨两列) */}
      <textarea className="input col-span-2" rows={2} placeholder="补充说明(可选)" value={item.description}
        onChange={(e) => update({ description: e.target.value })} />
    </div>
  );
}

/** 工作经历字段表单(公司/职位/时间/描述)。 */
function ExperienceFields({
  item,
  update,
}: {
  item: ResumeExperience;
  update: (patch: Partial<ResumeExperience>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pr-6">
      {/* 公司 */}
      <input className="input" placeholder="公司" value={item.company}
        onChange={(e) => update({ company: e.target.value })} />
      {/* 职位 */}
      <input className="input" placeholder="职位" value={item.position}
        onChange={(e) => update({ position: e.target.value })} />
      {/* 开始时间 */}
      <input className="input" placeholder="开始" value={item.start}
        onChange={(e) => update({ start: e.target.value })} />
      {/* 结束时间 */}
      <input className="input" placeholder="结束" value={item.end}
        onChange={(e) => update({ end: e.target.value })} />
      {/* 工作内容与成果(跨两列) */}
      <textarea className="input col-span-2" rows={3} placeholder="工作内容与成果" value={item.description}
        onChange={(e) => update({ description: e.target.value })} />
    </div>
  );
}

/** 项目经历字段表单(项目名/角色/时间/描述/技术栈)。 */
function ProjectFields({
  item,
  update,
}: {
  item: ResumeProject;
  update: (patch: Partial<ResumeProject>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pr-6">
      {/* 项目名 */}
      <input className="input" placeholder="项目名" value={item.name}
        onChange={(e) => update({ name: e.target.value })} />
      {/* 角色 */}
      <input className="input" placeholder="角色" value={item.role}
        onChange={(e) => update({ role: e.target.value })} />
      {/* 开始时间 */}
      <input className="input" placeholder="开始" value={item.start}
        onChange={(e) => update({ start: e.target.value })} />
      {/* 结束时间 */}
      <input className="input" placeholder="结束" value={item.end}
        onChange={(e) => update({ end: e.target.value })} />
      {/* 项目描述(跨两列) */}
      <textarea className="input col-span-2" rows={2} placeholder="项目描述与成果" value={item.description}
        onChange={(e) => update({ description: e.target.value })} />
      {/* 技术栈:逗号分隔输入,自动拆分为数组(兼容中英文逗号) */}
      <input
        className="input col-span-2"
        placeholder="技术栈(逗号分隔)"
        value={item.tech_stack.join(", ")} // 数组转字符串展示
        onChange={(e) =>
          update({
            tech_stack: e.target.value // 按逗号拆分
              .split(/[,，]/)
              .map((s) => s.trim()) // 去空白
              .filter(Boolean), // 去空项
          })
        }
      />
    </div>
  );
}

/** 技能字段表单(分类 + 技能项列表)。 */
function SkillFields({
  item,
  update,
}: {
  item: ResumeSkill;
  update: (patch: Partial<ResumeSkill>) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 pr-6">
      {/* 技能分类名 */}
      <input className="input" placeholder="分类(如:编程语言)" value={item.category}
        onChange={(e) => update({ category: e.target.value })} />
      {/* 技能项:逗号分隔输入,自动拆分为数组 */}
      <input
        className="input"
        placeholder="技能项(逗号分隔)"
        value={item.items.join(", ")} // 数组转字符串展示
        onChange={(e) =>
          update({
            items: e.target.value // 按逗号拆分(兼容中英文逗号)
              .split(/[,，]/)
              .map((s) => s.trim()) // 去空白
              .filter(Boolean), // 去空项
          })
        }
      />
    </div>
  );
}
