"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import type { Position, PositionListItem } from "@/lib/types";

interface DraftPosition {
  name: string;
  company_name: string;
  company_business_scope: string;
  job_title: string;
  job_requirements: string;
  notes: string;
}

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

export default function PositionsPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-400">加载中…</div>}>
      <PositionsPage />
    </Suspense>
  );
}

function PositionsPage() {
  const searchParams = useSearchParams();
  const [list, setList] = useState<PositionListItem[]>([]);
  const [current, setCurrent] = useState<Position | null>(null);
  const [draft, setDraft] = useState<DraftPosition>(emptyDraft());
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  // 列表容器 ref,用于滚动定位到选中项
  const listRef = useRef<HTMLDivElement>(null);
  // 记录上次已处理的 positionParam,避免列表刷新时反复跳回参数指定的职位
  const processedParamRef = useRef<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  // 支持 ?position=<id> 预选(从面试分析溯源跳转过来)
  const positionParam = searchParams.get("position");
  useEffect(() => {
    if (list.length === 0) return;

    // 1) 如果 URL 参数变化了(或首次出现),优先选中参数指定的职位
    if (positionParam && positionParam !== processedParamRef.current) {
      processedParamRef.current = positionParam;
      const exists = list.some((p) => p.id === positionParam);
      if (exists) {
        selectPosition(positionParam);
        return;
      }
    }

    // 2) 如果当前没有选中(或选中的已被删除),不自动选中(职位页默认显示空状态)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionParam, list]);

  // 选中项变化时滚动到列表中对应位置
  useEffect(() => {
    if (!current || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-position-id="${current.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [current]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listPositions();
      setList(r.positions || []);
    } catch {
      setError("加载职位列表失败");
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setCurrent(null);
    setIsNew(true);
    setDraft(emptyDraft());
    setError("");
  }

  async function selectPosition(id: string) {
    if (!id) return;
    setError("");
    try {
      const r = await api.getPosition(id);
      setCurrent(r.position);
      setIsNew(false);
      setDraft({
        name: r.position.name,
        company_name: r.position.company_name,
        company_business_scope: r.position.company_business_scope,
        job_title: r.position.job_title,
        job_requirements: r.position.job_requirements,
        notes: r.position.notes,
      });
    } catch {
      setError("加载职位详情失败");
    }
  }

  function patch(p: Partial<DraftPosition>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  async function save() {
    if (!draft.job_requirements.trim()) {
      setError("请填写 JD 正文(必填)");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (isNew) {
        const r = await api.createPosition(draft);
        setCurrent(r.position);
        setIsNew(false);
        setToast("已创建职位");
      } else if (current) {
        const r = await api.updatePosition(current.id, draft);
        setCurrent(r.position);
        setToast("已保存");
      }
      await refresh();
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!current) return;
    if (!confirm(`确定删除「${current.name}」?此操作不可撤销。`)) return;
    try {
      await api.deletePosition(current.id);
      setCurrent(null);
      setIsNew(false);
      setDraft(emptyDraft());
      setToast("已删除");
      await refresh();
    } catch {
      setError("删除失败");
    }
  }

  const filtered = list.filter((p) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.company_name.toLowerCase().includes(q) ||
      p.job_title.toLowerCase().includes(q) ||
      p.job_requirements.toLowerCase().includes(q)
    );
  });

  const showEditor = isNew || current;

  return (
    <div className="flex h-screen">
      {/* 左侧:职位列表 */}
      <div
        className="w-[320px] shrink-0 flex flex-col border-r"
        style={{ background: "var(--bg-sidebar)", borderColor: "var(--border)" }}
      >
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="badge badge-accent mb-1.5">职位库</div>
              <h1 className="text-[18px] font-semibold text-stone-800">JD 收藏与管理</h1>
            </div>
            <button onClick={startNew} className="btn btn-primary text-[12px] px-3 py-1.5">
              + 新建
            </button>
          </div>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索职位 / 公司 / 关键词…"
          />
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
          {loading && list.length === 0 && (
            <div className="text-center text-[12px] text-stone-400 py-8">加载中…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-center text-[12px] text-stone-400 py-12 px-4 leading-relaxed">
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
          {filtered.map((p) => {
            const active = current?.id === p.id;
            return (
              <button
                key={p.id}
                data-position-id={p.id}
                onClick={() => selectPosition(p.id)}
                className="w-full text-left p-3 rounded-lg transition"
                style={{
                  background: active ? "var(--bg-elevated)" : "transparent",
                  border: active ? "1px solid var(--accent-bg)" : "1px solid transparent",
                }}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-[13px] font-medium text-stone-800 truncate flex-1">
                    {p.name}
                  </div>
                  {p.job_title && (
                    <span className="badge badge-muted text-[10px] shrink-0">{p.job_title}</span>
                  )}
                </div>
                {p.company_name && (
                  <div className="text-[11px] text-stone-500 truncate mb-0.5">
                    {p.company_name}
                  </div>
                )}
                <div className="text-[10px] text-stone-400">
                  {relativeTime(p.updated_at || p.created_at)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧:编辑器 / 空状态 */}
      <div className="flex-1 overflow-y-auto">
        {!showEditor ? (
          <div className="h-full flex items-center justify-center px-8">
            <div className="text-center max-w-md">
              <div className="text-5xl mb-4 opacity-60">📋</div>
              <h2 className="text-[18px] font-semibold text-stone-700 mb-2">管理你的职位 JD</h2>
              <p className="text-[13px] text-stone-500 leading-relaxed mb-6">
                在这里收藏你感兴趣的岗位 JD,填写公司、职位与要求。
                在「面试分析」页可以一键选择已保存的职位,自动填充表单进行分析。
              </p>
              <button onClick={startNew} className="btn btn-primary">
                + 新建第一个职位
              </button>
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
          <div className="max-w-[720px] mx-auto px-8 py-8">
            {/* 头部 */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="badge badge-accent mb-1.5">
                  {isNew ? "新建职位" : "编辑职位"}
                </div>
                <h1 className="text-[20px] font-semibold text-stone-800">
                  {draft.name || (isNew ? "未命名职位" : current?.name || "职位")}
                </h1>
                {!isNew && current && (
                  <div className="text-[11px] text-stone-400 mt-0.5">
                    创建于 {relativeTime(current.created_at)} · 更新于 {relativeTime(current.updated_at)}
                  </div>
                )}
              </div>
              {!isNew && current && (
                <button onClick={remove} className="btn btn-danger text-[12px]">
                  删除
                </button>
              )}
            </div>

            {/* 表单 */}
            <div className="card p-5 space-y-4">
              <div className="section-title">基本信息</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">职位名称(用于列表显示)</label>
                  <input
                    className="input"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="留空则自动用 公司 · 职位 生成"
                  />
                </div>
                <div>
                  <label className="label">公司名称(可选)</label>
                  <input
                    className="input"
                    value={draft.company_name}
                    onChange={(e) => patch({ company_name: e.target.value })}
                    placeholder="如:字节跳动"
                  />
                </div>
                <div>
                  <label className="label">职位名称(可选)</label>
                  <input
                    className="input"
                    value={draft.job_title}
                    onChange={(e) => patch({ job_title: e.target.value })}
                    placeholder="如:高级产品经理"
                  />
                </div>
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

              {error && (
                <div
                  className="px-3 py-2 rounded-lg text-[12px]"
                  style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                >
                  {error}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={save}
                  disabled={saving || !draft.job_requirements.trim()}
                  className="btn btn-primary"
                >
                  {saving ? "保存中…" : isNew ? "创建职位" : "保存修改"}
                </button>
                <button
                  onClick={() => {
                    setIsNew(false);
                    setCurrent(null);
                    setDraft(emptyDraft());
                    setError("");
                  }}
                  className="btn btn-ghost"
                >
                  取消
                </button>
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

            {/* JD 预览 */}
            {draft.job_requirements.trim() && (
              <div className="card p-5 mt-5">
                <div className="section-title">JD 预览</div>
                <div className="prose-warm text-[13px] whitespace-pre-wrap leading-relaxed text-stone-700">
                  {draft.job_requirements}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

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
