"use client";

import { useEffect } from "react";

interface Props {
  /** 是否显示全屏 */
  open: boolean;
  /** 退出全屏回调 */
  onClose: () => void;
  /** 顶部标题(如简历名、公司·岗位) */
  title?: string;
  /** 标题旁的副标题(如"面试分析报告 · 按 Esc 退出") */
  subtitle?: string;
  /** 全屏内容 */
  children: React.ReactNode;
  /** 内容最大宽度,默认 960px */
  maxWidth?: number;
}

/**
 * 全屏预览覆盖层。
 *
 * - 点击「全屏预览」按钮触发,铺满视口
 * - 顶部工具条:标题 + 副标题 + 退出全屏按钮
 * - 内容区可滚动,居中显示,默认最大宽度 960px
 * - 支持 Esc 键退出、锁定 body 滚动
 */
export default function FullscreenPreview({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = 960,
}: Props) {
  // Esc 键退出 + 锁定 body 滚动
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col fade-in"
      style={{ background: "var(--bg-muted)" }}
    >
      {/* 顶部工具条 */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b shrink-0"
        style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
      >
        <div className="text-[14px] font-medium text-stone-700 truncate">
          {title}
          {subtitle && (
            <span className="text-stone-400 ml-2 text-[12px] font-normal">{subtitle}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="btn btn-secondary text-[12px] flex items-center gap-1.5"
          title="退出全屏"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 4v4H4M16 4v4h4M4 16v4h4M16 20v4h4v-4"
            />
          </svg>
          退出全屏
        </button>
      </div>
      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto" style={{ maxWidth }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 触发全屏的按钮(四角向外箭头图标) */
export function FullscreenButton({
  onClick,
  label = "全屏预览",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="btn btn-ghost text-[12px] flex items-center gap-1.5"
      title={label}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 8V4h4M16 4h4v4M4 16v4h4M16 20h4v-4"
        />
      </svg>
      {label}
    </button>
  );
}
