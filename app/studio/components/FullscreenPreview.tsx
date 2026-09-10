"use client"; // 客户端组件:需要访问 window 事件与 body 样式

import { useEffect } from "react";

/** FullscreenPreview 组件的 props 定义。 */
interface Props {
  /** 是否显示全屏 */
  open: boolean;
  /** 退出全屏回调(点击按钮或按 Esc 时触发) */
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
 * 行为说明:
 * - 点击「全屏预览」按钮触发,铺满整个视口(fixed + inset-0 + z-50)
 * - 顶部工具条:标题 + 副标题 + 退出全屏按钮
 * - 内容区可滚动、水平居中,默认最大宽度 960px
 * - 打开期间支持 Esc 键退出、锁定 body 滚动(防止背景页面滚动穿透)
 *
 * @param open - 是否打开全屏
 * @param onClose - 关闭回调
 * @param title - 顶部标题
 * @param subtitle - 顶部副标题
 * @param children - 全屏内容
 * @param maxWidth - 内容最大宽度,默认 960
 */
export default function FullscreenPreview({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = 960,
}: Props) {
  // ── 副作用:Esc 键退出 + 锁定 body 滚动 ──
  useEffect(() => {
    if (!open) return; // 未打开时不做任何绑定
    // 监听 Esc 键:按下即触发退出回调
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(); // Esc 键退出全屏
    };
    window.addEventListener("keydown", handler); // 注册键盘监听
    document.body.style.overflow = "hidden"; // 锁定 body 滚动,防止背景滚动穿透
    // 清理函数:卸载/关闭时移除监听并恢复滚动
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = ""; // 恢复 body 滚动
    };
  }, [open, onClose]); // 依赖 open 与 onClose:关闭后解除绑定

  if (!open) return null; // 未打开时不渲染任何 DOM

  return (
    // ── 全屏覆盖层:铺满视口,flex 纵向布局 ──
    <div
      className="fixed inset-0 z-50 flex flex-col fade-in" // fixed 铺满 + 淡入动画
      style={{ background: "var(--bg-muted)" }} // 弱化底色
    >
      {/* 顶部工具条:标题区(左) + 退出按钮(右) */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b shrink-0"
        style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }} // 分隔线 + 抬升底色
      >
        {/* 标题 + 副标题 */}
        <div className="text-[14px] font-medium text-stone-700 truncate">
          {title}
          {/* 副标题存在时以小号灰字展示 */}
          {subtitle && (
            <span className="text-stone-400 ml-2 text-[12px] font-normal">{subtitle}</span>
          )}
        </div>
        {/* 退出全屏按钮 */}
        <button
          onClick={onClose} // 点击触发关闭回调
          className="btn btn-secondary text-[12px] flex items-center gap-1.5"
          title="退出全屏"
        >
          {/* 缩小图标(四角向内箭头) */}
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
      {/* 内容区:可滚动,上下留白 */}
      <div className="flex-1 overflow-y-auto p-8">
        {/* 内容容器:水平居中,限制最大宽度 */}
        <div className="mx-auto" style={{ maxWidth }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * 触发全屏的按钮(四角向外箭头图标)。
 * 独立成组件,方便在预览区域标题栏直接引用。
 * @param onClick - 点击回调(通常为 setOpen(true))
 * @param label - 按钮文字,默认"全屏预览"
 */
export function FullscreenButton({
  onClick,
  label = "全屏预览",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      onClick={onClick} // 点击触发全屏
      className="btn btn-ghost text-[12px] flex items-center gap-1.5"
      title={label}
    >
      {/* 放大图标(四角向外箭头) */}
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
