"use client"; // 客户端组件:需要访问 localStorage、window 事件与路由

// 引入 Next.js 路由组件与 React hooks
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * 侧边栏导航配置:6 个导航项。
 * 每项包含路由 key、展示名、路由路径、SVG 图标 path 数据与描述。
 */
const NAV = [
  {
    key: "resumes", // 路由标识
    label: "简历", // 侧边栏展示名
    href: "/resumes", // 路由路径
    // 图标:文档图标(SVG path d 数据)
    icon: "M9 12h6m-6 4h6m-6-8h6M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z",
    desc: "编辑与导出", // 导航项小字描述
  },
  {
    key: "positions",
    label: "职位库",
    href: "/positions",
    // 图标:文件夹图标
    icon: "M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
    desc: "JD 收藏与管理",
  },
  {
    key: "analysis",
    label: "面试分析",
    href: "/analysis",
    // 图标:柱状图图标
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    desc: "JD × 简历报告",
  },
  {
    key: "interview",
    label: "模拟面试",
    href: "/interview",
    // 图标:对话气泡图标
    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
    desc: "AI 实战对练",
  },
  {
    key: "history",
    label: "历史记录",
    href: "/history",
    // 图标:时钟图标
    icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
    desc: "分析与面试归档",
  },
  {
    key: "settings",
    label: "设置",
    href: "/settings",
    // 图标:齿轮图标
    icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
    desc: "模型与配置",
  },
];

/** localStorage 键名:记录侧边栏折叠状态("1" = 折叠)。 */
const COLLAPSE_KEY = "hiremind:sidebar-collapsed";

/**
 * 全局侧边栏组件。
 *
 * 功能:
 * - 6 个导航项,当前路由高亮(精确匹配 + 子路径前缀匹配)
 * - 可折叠:240px ↔ 64px,状态持久化到 localStorage
 * - 底部实时显示后端健康状态(绿点/红点 + 检测中灰点)
 * - 后端在线时显示当前模型名,监听 hiremind:model-changed 事件刷新
 * - 折叠态下导航项 hover 显示文字 Tooltip
 */
export default function Sidebar() {
  const pathname = usePathname(); // 当前路由路径(用于导航高亮判断)
  const [backendOk, setBackendOk] = useState<boolean | null>(null); // 后端健康状态:null=检测中
  const [modelName, setModelName] = useState(""); // 当前模型名
  // 折叠状态:从 localStorage 读取,默认展开
  const [collapsed, setCollapsed] = useState(false);
  // 已挂载标记:避免首屏 hydration mismatch(SSR 先渲染展开态,挂载后再同步 localStorage)
  const [mounted, setMounted] = useState(false);

  // ── 挂载时同步折叠状态(仅执行一次) ──
  useEffect(() => {
    setMounted(true); // 标记已挂载
    const saved = localStorage.getItem(COLLAPSE_KEY); // 读取持久化的折叠状态
    if (saved === "1") setCollapsed(true); // 值为 "1" 时恢复折叠
  }, []);

  // ── 折叠状态变更时写回 localStorage(持久化用户偏好) ──
  useEffect(() => {
    if (!mounted) return; // 挂载前不写(避免覆盖 SSR 初始状态)
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed, mounted]);

  /**
   * 拉取后端健康状态与当前模型信息。
   * 返回清理函数:置 active=false 防止卸载后异步 setState。
   */
  const fetchModelInfo = () => {
    let active = true; // 本次拉取的存活标记
    api
      .health() // 先探测后端健康
      .then(() => {
        if (!active) return; // 组件已卸载则不再更新
        setBackendOk(true); // 后端在线
        // 后端 OK 后再拉取当前模型信息
        api.getModelInfo().then((info) => {
          if (active) setModelName(info.model || ""); // 更新模型名
        }).catch(() => {}); // 模型信息拉取失败静默处理
      })
      .catch(() => active && setBackendOk(false)); // 健康探测失败 → 后端离线
    return () => {
      active = false; // 清理:标记失效
    };
  };

  // ── 挂载时拉取 + 监听全局模型变更事件(仅执行一次) ──
  useEffect(() => {
    const cleanup = fetchModelInfo(); // 首次拉取健康与模型信息
    // 监听全局事件:设置页修改模型后触发刷新
    const onModelChanged = () => fetchModelInfo();
    window.addEventListener("hiremind:model-changed", onModelChanged);
    // 清理函数:取消拉取标记 + 移除事件监听
    return () => {
      cleanup();
      window.removeEventListener("hiremind:model-changed", onModelChanged);
    };
  }, []);

  /** 切换折叠/展开状态(函数式更新,不依赖旧值闭包)。 */
  function toggleCollapsed() {
    setCollapsed((c) => !c);
  }

  return (
    // ── 侧边栏外壳:固定高度 + sticky 定位 + 宽度过渡动画 ──
    <aside
      className="flex flex-col shrink-0 h-screen sticky top-0 transition-[width] duration-200 ease-out"
      style={{
        width: collapsed ? 64 : 180, // 折叠 64px / 展开 240px
        background: "var(--bg-sidebar)", // 侧边栏专用底色
        borderRight: "1px solid var(--border)", // 右侧分隔线
      }}
    >
      {/* ── Logo 区 + 折叠按钮 ── */}
      <div className="px-3 pt-5 pb-4 flex items-center justify-between">
        {collapsed ? (
          // 折叠态:只显示 H 图标按钮,点击展开
          <button
            onClick={toggleCollapsed}
            aria-label="展开侧边栏"
            title="展开"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0 mx-auto"
            style={{
              // 品牌渐变底色(品牌橙 → 深橙)
              background:
                "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
              boxShadow: "0 2px 8px -2px rgba(194, 65, 12, 0.4)", // 品牌阴影
            }}
          >
            H
          </button>
        ) : (
          <>
            {/* 展开态:Logo 链接(点击回首页) */}
            <Link href="/" className="flex items-center gap-2.5 group flex-1 min-w-0">
              {/* 品牌 Logo 方块 */}
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0"
                style={{
                  background:
                    "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
                  boxShadow: "0 2px 8px -2px rgba(194, 65, 12, 0.4)",
                }}
              >
                H
              </div>
              {/* 品牌名 + 副标题 */}
              <div className="leading-tight min-w-0">
                <div className="text-[15px] font-semibold text-stone-800">
                  HireMind
                </div>
                <div className="text-[11px] text-stone-500 truncate">
                  AI 面试官工作台
                </div>
              </div>
            </Link>
            {/* 收起按钮(双左箭头图标) */}
            <button
              onClick={toggleCollapsed}
              aria-label="收起侧边栏"
              title="收起"
              className="w-7 h-7 rounded-md flex items-center justify-center text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition shrink-0"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* ── 导航列表 ── */}
      <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
        {NAV.map((item) => {
          // 高亮判断:路径精确匹配或属于该路由的子路径
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.key}
              href={item.href}
              title={collapsed ? item.label : undefined} // 折叠态用 title 显示文字
              className={`flex items-center gap-3 rounded-lg transition-all relative ${
                collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"
              } ${
                // 高亮项加深文字色,否则弱化
                active
                  ? "text-stone-900 font-medium"
                  : "text-stone-600 hover:text-stone-900"
              }`}
              style={{
                background: active ? "var(--bg-elevated)" : "transparent", // 高亮背景
                boxShadow: active
                  ? "0 1px 3px -1px rgb(28 25 23 / 0.08)" // 高亮阴影
                  : "none",
              }}
            >
              {/* 导航图标:高亮时品牌橙,否则灰色 */}
              <svg
                className={`w-[18px] h-[18px] shrink-0 ${
                  active ? "text-orange-700" : "text-stone-400"
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={item.icon} // 使用配置中的 SVG path 数据
                />
              </svg>
              {/* 展开态:文字 + 描述 + 高亮指示条 */}
              {!collapsed && (
                <div className="flex-1 min-w-0 flex items-center justify-between">
                  <div className="min-w-0">
                    {/* 导航名 */}
                    <div className="text-[13px] leading-tight">{item.label}</div>
                    {/* 小字描述 */}
                    <div className="text-[10px] text-stone-400 leading-tight mt-0.5">
                      {item.desc}
                    </div>
                  </div>
                  {/* 展开态高亮指示:右侧竖条 */}
                  {active && (
                    <span
                      className="w-1 h-4 rounded-full shrink-0"
                      style={{ background: "var(--accent)" }}
                    />
                  )}
                </div>
              )}
              {/* 折叠态高亮指示:左侧竖条(absolute 定位) */}
              {collapsed && active && (
                <span
                  className="absolute left-0 w-1 h-5 rounded-r-full"
                  style={{ background: "var(--accent)" }}
                />
              )}
            </Link>
          );
        })}
      </nav>

      {/* ── 底部:后端状态 + 折叠态展开按钮 + 当前模型 ── */}
      <div className="p-2">
        {/* 折叠态:显示展开按钮(双右箭头) */}
        {collapsed ? (
          <button
            onClick={toggleCollapsed}
            aria-label="展开侧边栏"
            title="展开"
            className="w-full h-8 rounded-md flex items-center justify-center text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 5l7 7-7 7M5 5l7 7-7 7"
              />
            </svg>
          </button>
        ) : null}
        {/* 后端健康状态指示器:圆点 + 文字 */}
        <div
          className={`flex items-center gap-2 rounded-lg text-[11px] mt-1 ${
            collapsed ? "justify-center px-1 py-2" : "px-3 py-2"
          }`}
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            color: "var(--fg-muted)",
          }}
          title={collapsed ? (backendOk ? "后端已连接" : "后端未连接") : undefined}
        >
          {/* 状态圆点:灰=检测中 / 绿=在线 / 红=离线 */}
          <span
            className="w-1.5 h-1.5 rounded-full pulse-soft shrink-0"
            style={{
              background:
                backendOk === null
                  ? "#a8a29e" // 检测中:灰色
                  : backendOk
                    ? "var(--success)" // 在线:绿色
                    : "var(--danger)", // 离线:红色
            }}
          />
          {/* 展开态:显示状态文字 */}
          {!collapsed && (
            <span className="flex-1">
              {backendOk === null
                ? "检测后端…"
                : backendOk
                  ? "后端已连接"
                  : "后端未连接"}
            </span>
          )}
        </div>
        {/* 当前模型(仅后端在线 + 有模型名 + 展开态时显示) */}
        {backendOk && modelName && !collapsed && (
          <div
            className="flex items-center gap-1.5 rounded-lg text-[11px] mt-1 px-3 py-2"
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              color: "var(--fg-muted)",
            }}
            title={`当前模型: ${modelName}`}
          >
            {/* 闪电图标 */}
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {/* 模型名,超长截断 */}
            <span className="truncate">{modelName}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
