"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const NAV = [
  {
    key: "resumes",
    label: "简历",
    href: "/resumes",
    icon: "M9 12h6m-6 4h6m-6-8h6M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z",
    desc: "编辑与导出",
  },
  {
    key: "positions",
    label: "职位库",
    href: "/positions",
    icon: "M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
    desc: "JD 收藏与管理",
  },
  {
    key: "analysis",
    label: "面试分析",
    href: "/analysis",
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    desc: "JD × 简历报告",
  },
  {
    key: "interview",
    label: "模拟面试",
    href: "/interview",
    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
    desc: "AI 实战对练",
  },
  {
    key: "history",
    label: "历史记录",
    href: "/history",
    icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
    desc: "分析与面试归档",
  },
  {
    key: "settings",
    label: "设置",
    href: "/settings",
    icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
    desc: "模型与配置",
  },
];

const COLLAPSE_KEY = "hiremind:sidebar-collapsed";

export default function Sidebar() {
  const pathname = usePathname();
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState("");
  // 折叠状态：从 localStorage 读取,默认展开
  const [collapsed, setCollapsed] = useState(false);
  // 避免首屏 hydration mismatch：先渲染为 false,挂载后再同步 localStorage
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem(COLLAPSE_KEY);
    if (saved === "1") setCollapsed(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed, mounted]);

  // 拉取后端健康状态与当前模型信息
  const fetchModelInfo = () => {
    let active = true;
    api
      .health()
      .then(() => {
        if (!active) return;
        setBackendOk(true);
        // 后端 OK 后拉取当前模型信息
        api.getModelInfo().then((info) => {
          if (active) setModelName(info.model || "");
        }).catch(() => {});
      })
      .catch(() => active && setBackendOk(false));
    return () => {
      active = false;
    };
  };

  useEffect(() => {
    const cleanup = fetchModelInfo();
    // 监听全局事件:设置页修改模型后触发刷新
    const onModelChanged = () => fetchModelInfo();
    window.addEventListener("hiremind:model-changed", onModelChanged);
    return () => {
      cleanup();
      window.removeEventListener("hiremind:model-changed", onModelChanged);
    };
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => !c);
  }

  return (
    <aside
      className="flex flex-col shrink-0 h-screen sticky top-0 transition-[width] duration-200 ease-out"
      style={{
        width: collapsed ? 64 : 240,
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {/* Logo + 折叠按钮 */}
      <div className="px-3 pt-5 pb-4 flex items-center justify-between">
        {collapsed ? (
          // 折叠态：只显示 H 图标,点击展开
          <button
            onClick={toggleCollapsed}
            aria-label="展开侧边栏"
            title="展开"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0 mx-auto"
            style={{
              background:
                "linear-gradient(135deg, var(--accent) 0%, #ea580c 100%)",
              boxShadow: "0 2px 8px -2px rgba(194, 65, 12, 0.4)",
            }}
          >
            H
          </button>
        ) : (
          <>
            <Link href="/" className="flex items-center gap-2.5 group flex-1 min-w-0">
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
              <div className="leading-tight min-w-0">
                <div className="text-[15px] font-semibold text-stone-800">
                  HireMind
                </div>
                <div className="text-[11px] text-stone-500 truncate">
                  AI 面试官工作台
                </div>
              </div>
            </Link>
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

      {/* 导航 */}
      <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.key}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-3 rounded-lg transition-all relative ${
                collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"
              } ${
                active
                  ? "text-stone-900 font-medium"
                  : "text-stone-600 hover:text-stone-900"
              }`}
              style={{
                background: active ? "var(--bg-elevated)" : "transparent",
                boxShadow: active
                  ? "0 1px 3px -1px rgb(28 25 23 / 0.08)"
                  : "none",
              }}
            >
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
                  d={item.icon}
                />
              </svg>
              {!collapsed && (
                <div className="flex-1 min-w-0 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-[13px] leading-tight">{item.label}</div>
                    <div className="text-[10px] text-stone-400 leading-tight mt-0.5">
                      {item.desc}
                    </div>
                  </div>
                  {active && (
                    <span
                      className="w-1 h-4 rounded-full shrink-0"
                      style={{ background: "var(--accent)" }}
                    />
                  )}
                </div>
              )}
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

      {/* 后端状态 + 展开按钮（折叠态） */}
      <div className="p-2">
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
          <span
            className="w-1.5 h-1.5 rounded-full pulse-soft shrink-0"
            style={{
              background:
                backendOk === null
                  ? "#a8a29e"
                  : backendOk
                    ? "var(--success)"
                    : "var(--danger)",
            }}
          />
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
        {/* 当前模型 */}
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
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="truncate">{modelName}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
