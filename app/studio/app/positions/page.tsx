"use client"; // 客户端组件:需要访问浏览器 API、sessionStorage 与 URL 参数

// 引入 React hooks、Next.js 路由能力与 API 客户端
import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import type { Position, PositionListItem } from "@/lib/types";

/** 职位草稿表单的数据结构(与后端 Position 字段对齐,仅编辑用)。 */
interface DraftPosition {
  name: string; // 职位记录名称
  company_name: string; // 公司名称
  company_business_scope: string; // 公司业务范围
  job_title: string; // 职位名称
  job_requirements: string; // JD 正文(必填)
  notes: string; // 备注
}

/** 返回一份全新的空职位草稿(新建职位时初始化表单)。 */
function emptyDraft(): DraftPosition {
  return {
    name: "",
    company_name: "",
    company_business_scope: "",
    job_title: "",
    job_requirements: "",
    notes: "",
  };
}

/**
 * 页面包装组件:用 Suspense 包裹。
 * useSearchParams 在 App Router 中需要 Suspense 边界,
 * 否则构建时会被判定为需要预渲染而报错。
 */
export default function PositionsPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <PositionsPage />
    </Suspense>
  );
}

/**
 * 职位库页面:左侧职位列表 + 右侧 JD 编辑表单。
 *
 * 功能:
 * - 列表搜索(公司/职位/JD 模糊匹配)
 * - 新建/编辑/删除职位
 * - 支持 ?position=<id> URL 预选(从面试分析页溯源跳转)
 * - 选中时同步 URL 参数 + 写入 sessionStorage(供 Ask 助手感知)
 * - 「用此职位去分析」一键跳转分析页并带入职位
 */
function PositionsPage() {
  const searchParams = useSearchParams(); // 读取 URL 查询参数(?position=)
  const [list, setList] = useState<PositionListItem[]>([]); // 职位列表
  const [current, setCurrent] = useState<Position | null>(null); // 当前选中的职位详情
  const [draft, setDraft] = useState<DraftPosition>(emptyDraft()); // 编辑表单草稿
  const [isNew, setIsNew] = useState(false); // 是否处于新建模式
  const [loading, setLoading] = useState(false); // 列表加载中
  const [saving, setSaving] = useState(false); // 保存中
  const [error, setError] = useState(""); // 错误提示
  const [toast, setToast] = useState(""); // 成功提示(2 秒自动消失)
  const [query, setQuery] = useState(""); // 搜索关键词
  // 列表容器 ref,用于滚动定位到选中项
  const listRef = useRef<HTMLDivElement>(null);
  // 记录上次已处理的 positionParam,避免列表刷新时反复跳回参数指定的职位
  const processedParamRef = useRef<string | null>(null);

  // 挂载时加载职位列表
  useEffect(() => {
    refresh();
  }, []);

  // ── 支持 ?position=<id> 预选(从面试分析溯源跳转过来) ──
  const positionParam = searchParams.get("position");
  useEffect(() => {
    if (list.length === 0) return; // 列表未加载完先不处理

    // 1) 如果 URL 参数变化了(或首次出现),优先选中参数指定的职位
    if (positionParam && positionParam !== processedParamRef.current) {
      processedParamRef.current = positionParam; // 标记已处理,防止重复触发
      const exists = list.some((p) => p.id === positionParam); // 参数职位是否在列表中
      if (exists) {
        selectPosition(positionParam); // 存在则选中它
        return;
      }
    }

    // 2) 如果当前没有选中(或选中的已被删除),不自动选中(职位页默认显示空状态)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionParam, list]);

  // ── 选中项变化时滚动到列表中对应位置 ──
  useEffect(() => {
    if (!current || !listRef.current) return; // 无选中或无列表容器则跳过
    // 通过 data-position-id 属性定位列表项 DOM
    const el = listRef.current.querySelector(`[data-position-id="${current.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" }); // 平滑滚动到可见区域
    }
  }, [current]); // 依赖当前选中项

  // ── toast 自动消失:显示 2 秒后清空 ──
  useEffect(() => {
    if (!toast) return; // 无提示则不设定时器
    const t = setTimeout(() => setToast(""), 2000); // 2 秒后清空
    return () => clearTimeout(t); // 卸载/变化时清理定时器
  }, [toast]);

  /** 刷新职位列表(拉取最新列表,不清空当前选中)。 */
  async function refresh() {
    setLoading(true); // 进入加载态
    try {
      const r = await api.listPositions();
      setList(r.positions || []); // 更新列表
    } catch {
      setError("加载职位列表失败");
    } finally {
      setLoading(false); // 无论成败都退出加载态
    }
  }

  /** 进入新建模式:清空草稿并显示空表单。 */
  function startNew() {
    setCurrent(null); // 清除当前选中
    setIsNew(true); // 标记新建模式
    setDraft(emptyDraft()); // 初始化空草稿
    setError(""); // 清空错误
  }

  /** 选中并加载一个职位:拉取详情、填充草稿、同步 URL 与 sessionStorage。 */
  async function selectPosition(id: string) {
    if (!id) return; // 空 ID 忽略
    setError(""); // 清空错误
    try {
      const r = await api.getPosition(id); // 拉取职位详情
      setCurrent(r.position); // 更新当前选中
      setIsNew(false); // 退出新建模式
      // 把详情填充到编辑草稿
      setDraft({
        name: r.position.name,
        company_name: r.position.company_name,
        company_business_scope: r.position.company_business_scope,
        job_title: r.position.job_title,
        job_requirements: r.position.job_requirements,
        notes: r.position.notes,
      });
      // 同步 URL 参数,让 Ask 助手能定位到当前查看的职位
      // 用 replaceState 避免触发 Next.js 路由重新渲染/滚动
      const url = new URL(window.location.href);
      if (url.searchParams.get("position") !== id) {
        url.searchParams.set("position", id); // 设置 position 参数
        window.history.replaceState(null, "", url); // 静默替换地址栏
      }
      // 写入 sessionStorage 供 Ask 助手读取当前查看的职位信息
      try {
        sessionStorage.setItem(
          "hiremind:position-state-v1",
          JSON.stringify({
            positionId: id, // 职位 ID
            name: r.position.name, // 职位记录名
            companyName: r.position.company_name || "", // 公司名
            jobTitle: r.position.job_title || "", // 岗位名
          }),
        );
      } catch {
        // sessionStorage 写入失败不影响主流程
      }
    } catch {
      setError("加载职位详情失败");
    }
  }

  /** 局部更新草稿字段(合并式更新)。 */
  function patch(p: Partial<DraftPosition>) {
    setDraft((d) => ({ ...d, ...p })); // 展开旧草稿并覆盖传入字段
  }

  /** 保存职位:新建走 createPosition,编辑走 updatePosition,保存后刷新列表。 */
  async function save() {
    // 必填校验:JD 正文不能为空
    if (!draft.job_requirements.trim()) {
      setError("请填写 JD 正文(必填)");
      return;
    }
    setSaving(true); // 进入保存态
    setError(""); // 清空错误
    try {
      if (isNew) {
        // 新建模式:调用创建接口
        const r = await api.createPosition(draft);
        setCurrent(r.position); // 选中新建的职位
        setIsNew(false); // 退出新建模式
        setToast("已创建职位"); // 成功提示
      } else if (current) {
        // 编辑模式:调用更新接口
        const r = await api.updatePosition(current.id, draft);
        setCurrent(r.position); // 更新当前选中
        setToast("已保存");
      }
      await refresh(); // 刷新列表(展示最新标题/时间)
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false); // 无论成败都退出保存态
    }
  }

  /** 删除当前职位:先 confirm 确认,再调用删除接口并刷新。 */
  async function remove() {
    if (!current) return; // 无选中则忽略
    if (!confirm(`确定删除「${current.name}」?此操作不可撤销。`)) return; // 用户取消
    try {
      await api.deletePosition(current.id); // 调用删除接口
      setCurrent(null); // 清除选中
      setIsNew(false);
      setDraft(emptyDraft()); // 重置草稿
      setToast("已删除");
      await refresh(); // 刷新列表
    } catch {
      setError("删除失败");
    }
  }

  // ── 搜索过滤:按名称/公司/岗位/JD 正文模糊匹配(大小写不敏感) ──
  const filtered = list.filter((p) => {
    if (!query.trim()) return true; // 无关键词返回全部
    const q = query.toLowerCase(); // 关键词转小写
    return (
      p.name.toLowerCase().includes(q) || // 匹配记录名
      p.company_name.toLowerCase().includes(q) || // 匹配公司名
      p.job_title.toLowerCase().includes(q) || // 匹配岗位名
      p.job_requirements.toLowerCase().includes(q) // 匹配 JD 正文
    );
  });

  // 右侧是否显示编辑器(新建模式或有选中职位)
  const showEditor = isNew || current;

  return (
    // 页面布局:左右分栏,高度铺满视口
    <div className="flex h-screen">
      {/* ═══ 左侧:职位列表 ═══ */}
      <div
        className="w-[320px] shrink-0 flex flex-col border-r"
        style={{ background: "var(--bg-sidebar)", borderColor: "var(--border)" }}
      >
        {/* 列表头部:标题 + 新建按钮 + 搜索框 */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              {/* 页签徽章 */}
              <div className="badge badge-accent mb-1.5">职位库</div>
              {/* 页面标题 */}
              <h1 className="text-[18px] font-semibold text-stone-800">JD 收藏与管理</h1>
            </div>
            {/* 新建按钮 */}
            <button onClick={startNew} className="btn btn-primary text-[12px] px-3 py-1.5">
              + 新建
            </button>
          </div>
          {/* 搜索输入框 */}
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索职位 / 公司 / 关键词…"
          />
        </div>

        {/* 职位卡片列表(可滚动) */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
          {/* 首次加载中:居中提示 */}
          {loading && list.length === 0 && (
            <div className="text-center text-[12px] text-stone-400 py-8">加载中…</div>
          )}
          {/* 空状态:无匹配结果 */}
          {!loading && filtered.length === 0 && (
            <div className="text-center text-[12px] text-stone-400 py-12 px-4 leading-relaxed">
              {/* 区分"列表为空"与"搜索无结果" */}
              {list.length === 0 ? (
                <>
                  <div className="mb-2">📁 职位库还是空的</div>
                  <div>点击右上角「新建」保存你的第一个职位 JD</div>
                </>
              ) : (
                "没有匹配的职位"
              )}
            </div>
          )}
          {/* 职位卡片:点击选中并加载详情 */}
          {filtered.map((p) => {
            const active = current?.id === p.id; // 是否当前选中项
            return (
              <button
                key={p.id}
                data-position-id={p.id} // 供滚动定位使用
                onClick={() => selectPosition(p.id)} // 点击选中
                className="w-full text-left p-3 rounded-lg transition"
                style={{
                  // 选中项:白底 + 橙色描边;否则透明
                  background: active ? "var(--bg-elevated)" : "transparent",
                  border: active ? "1px solid var(--accent-bg)" : "1px solid transparent",
                }}
              >
                {/* 第一行:记录名(左) + 岗位徽章(右) */}
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-[13px] font-medium text-stone-800 truncate flex-1">
                    {p.name} {/* 职位记录名 */}
                  </div>
                  {/* 岗位名徽章(可空) */}
                  {p.job_title && (
                    <span className="badge badge-muted text-[10px] shrink-0">{p.job_title}</span>
                  )}
                </div>
                {/* 公司名(可空) */}
                {p.company_name && (
                  <div className="text-[11px] text-stone-500 truncate mb-0.5">
                    {p.company_name}
                  </div>
                )}
                {/* 更新时间(优先 updated_at,回退 created_at) */}
                <div className="text-[10px] text-stone-400">
                  {relativeTime(p.updated_at || p.created_at)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ═══ 右侧:编辑器 / 空状态 ═══ */}
      <div className="flex-1 overflow-y-auto">
        {!showEditor ? (
          // ── 空状态:引导新建 ──
          <div className="h-full flex items-center justify-center px-8">
            <div className="text-center max-w-md">
              {/* 大图标 */}
              <div className="text-5xl mb-4 opacity-60">📋</div>
              <h2 className="text-[18px] font-semibold text-stone-700 mb-2">管理你的职位 JD</h2>
              {/* 引导文案 */}
              <p className="text-[13px] text-stone-500 leading-relaxed mb-6">
                在这里收藏你感兴趣的岗位 JD,填写公司、职位与要求。
                在「面试分析」页可以一键选择已保存的职位,自动填充表单进行分析。
              </p>
              {/* 新建按钮 */}
              <button onClick={startNew} className="btn btn-primary">
                + 新建第一个职位
              </button>
              {/* 跳转分析页链接 */}
              <div className="mt-8">
                <Link
                  href="/analysis"
                  className="text-[12px] text-orange-700 hover:underline"
                >
                  去面试分析页 →
                </Link>
              </div>
            </div>
          </div>
        ) : (
          // ── 编辑器:表单 + JD 预览 ──
          <div className="max-w-[720px] mx-auto px-8 py-8">
            {/* 头部:标题 + 删除按钮 */}
            <div className="flex items-center justify-between mb-6">
              <div>
                {/* 模式徽章:新建/编辑 */}
                <div className="badge badge-accent mb-1.5">
                  {isNew ? "新建职位" : "编辑职位"}
                </div>
                {/* 标题:优先草稿名,新建未命名时用占位 */}
                <h1 className="text-[20px] font-semibold text-stone-800">
                  {draft.name || (isNew ? "未命名职位" : current?.name || "职位")}
                </h1>
                {/* 时间信息(编辑模式) */}
                {!isNew && current && (
                  <div className="text-[11px] text-stone-400 mt-0.5">
                    创建于 {relativeTime(current.created_at)} · 更新于 {relativeTime(current.updated_at)}
                  </div>
                )}
              </div>
              {/* 删除按钮(仅编辑模式) */}
              {!isNew && current && (
                <button onClick={remove} className="btn btn-danger text-[12px]">
                  删除
                </button>
              )}
            </div>

            {/* 表单卡片 */}
            <div className="card p-5 space-y-4">
              {/* 基本信息区块标题 */}
              <div className="section-title">基本信息</div>
              {/* 双列网格:名称/公司/岗位/业务范围 */}
              <div className="grid grid-cols-2 gap-3">
                {/* 职位记录名称 */}
                <div>
                  <label className="label">职位名称(用于列表显示)</label>
                  <input
                    className="input"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="留空则自动用 公司 · 职位 生成"
                  />
                </div>
                {/* 公司名称(可选) */}
                <div>
                  <label className="label">公司名称(可选)</label>
                  <input
                    className="input"
                    value={draft.company_name}
                    onChange={(e) => patch({ company_name: e.target.value })}
                    placeholder="如:字节跳动"
                  />
                </div>
                {/* 职位名称(可选) */}
                <div>
                  <label className="label">职位名称(可选)</label>
                  <input
                    className="input"
                    value={draft.job_title}
                    onChange={(e) => patch({ job_title: e.target.value })}
                    placeholder="如:高级产品经理"
                  />
                </div>
                {/* 业务范围(可选,供分析时业务场景推演) */}
                <div>
                  <label className="label">业务范围(可选)</label>
                  <input
                    className="input"
                    value={draft.company_business_scope}
                    onChange={(e) => patch({ company_business_scope: e.target.value })}
                    placeholder="如:短视频、电商"
                  />
                </div>
              </div>

              {/* JD 正文(必填) */}
              <div>
                <label className="label">JD 正文 / 岗位要求 *</label>
                <textarea
                  className="input"
                  rows={10}
                  value={draft.job_requirements}
                  onChange={(e) => patch({ job_requirements: e.target.value })}
                  placeholder="把 JD 中的岗位职责与任职要求贴在这里…"
                />
                <div className="text-[11px] text-stone-400 mt-1.5">
                  支持直接粘贴招聘网站 JD,在分析页可一键带入
                </div>
              </div>

              {/* 备注(可选) */}
              <div>
                <label className="label">备注(可选)</label>
                <textarea
                  className="input"
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => patch({ notes: e.target.value })}
                  placeholder="如:薪资 30-50K · 上海 · 优先级高"
                />
              </div>

              {/* 错误提示(红底红字) */}
              {error && (
                <div
                  className="px-3 py-2 rounded-lg text-[12px]"
                  style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                >
                  {error}
                </div>
              )}

              {/* 操作按钮行:保存 + 取消 + 去分析 */}
              <div className="flex items-center gap-2">
                {/* 保存按钮:JD 为空或保存中时禁用 */}
                <button
                  onClick={save}
                  disabled={saving || !draft.job_requirements.trim()}
                  className="btn btn-primary"
                >
                  {saving ? "保存中…" : isNew ? "创建职位" : "保存修改"}
                </button>
                {/* 取消按钮:重置为未选中状态 */}
                <button
                  onClick={() => {
                    setIsNew(false); // 退出新建模式
                    setCurrent(null); // 清除选中
                    setDraft(emptyDraft()); // 清空草稿
                    setError(""); // 清空错误
                  }}
                  className="btn btn-ghost"
                >
                  取消
                </button>
                {/* 用此职位去分析(仅编辑模式):跳转分析页并携带职位 ID */}
                {!isNew && (
                  <Link
                    href={`/analysis?position=${current?.id}`}
                    className="btn btn-secondary ml-auto"
                  >
                    用此职位去分析 →
                  </Link>
                )}
              </div>
            </div>

            {/* JD 预览卡片(正文非空时显示) */}
            {draft.job_requirements.trim() && (
              <div className="card p-5 mt-5">
                <div className="section-title">JD 预览</div>
                {/* 保留换行的纯文本预览 */}
                <div className="prose-warm text-[13px] whitespace-pre-wrap leading-relaxed text-stone-700">
                  {draft.job_requirements}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 成功 toast(右下角浮层,2 秒自动消失) */}
      {toast && (
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
