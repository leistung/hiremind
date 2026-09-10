"use client"; // 客户端组件:需要拉取后端数据(useEffect + fetch)

// 引入 Next.js 路由组件与 React hooks
import Link from "next/link";
import { useEffect, useState } from "react";
// 引入 API 客户端、类型定义与工具函数
import { api } from "@/lib/api";
import type { InterviewListItem, ResumeListItem } from "@/lib/types";
import { relativeTime } from "@/lib/utils";

/**
 * 首页功能卡片配置:三大核心功能的入口。
 * 每项包含路由、标题、描述、SVG 图标与强调色。
 */
const FEATURES = [
  {
    href: "/resumes", // 目标路由
    title: "简历", // 卡片标题
    desc: "在线编辑简历,选择模板,一键导出 Word / PDF", // 功能描述
    // 文档图标(SVG path)
    icon: "M9 12h6m-6 4h6m-6-8h6M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z",
    accent: "#c2410c", // 强调色(橙红)
  },
  {
    href: "/analysis",
    title: "面试分析",
    desc: "输入 JD 与简历,生成匹配度、改进点、面试题与参考答案",
    // 柱状图图标
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    accent: "#b45309", // 强调色(琥珀)
  },
  {
    href: "/interview",
    title: "模拟面试",
    desc: "基于分析报告进行 AI 自适应提问,生成评估与学习建议",
    // 对话气泡图标
    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
    accent: "#15803d", // 强调色(绿)
  },
];

/**
 * 首页:欢迎语 + 功能入口 + 最近活动概览。
 *
 * 数据:挂载时并行拉取最近 3 条简历与最近 3 场面试,
 * 展示在「最近简历」「最近面试」卡片中。
 */
export default function HomePage() {
  const [resumes, setResumes] = useState<ResumeListItem[]>([]); // 最近简历列表
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]); // 最近面试列表

  // 挂载时并行拉取首页概览数据
  useEffect(() => {
    Promise.all([api.listResumes(), api.listInterviews()]) // 并行请求
      .then(([r, i]) => {
        setResumes((r.resumes || []).slice(0, 3)); // 取最近 3 条简历
        setInterviews((i.interviews || []).slice(0, 3)); // 取最近 3 场面试
      })
      .catch(() => {}); // 拉取失败静默处理(首页照常展示)
  }, []);

  return (
    // 页面容器:最大宽度 + 水平居中 + 上下留白
    <div className="max-w-5xl mx-auto px-8 py-12">
      {/* ── Hero 区:版本徽章 + 主标题 + 简介 ── */}
      <div className="mb-10">
        {/* 版本徽章 */}
        <div className="badge badge-accent mb-3">v0.3 · 暖色文档风</div>
        {/* 主标题 */}
        <h1 className="text-3xl font-semibold text-stone-800 tracking-tight mb-3">
          让每一次面试都有备而来
        </h1>
        {/* 平台简介 */}
        <p className="text-stone-500 text-[15px] leading-relaxed max-w-2xl">
          HireMind 是一个 AI 驱动的面试准备平台:结构化简历编辑、JD × 简历深度分析、
          自适应模拟面试,从准备到实战完整覆盖。
        </p>
      </div>

      {/* ── 功能卡片:三列网格 ── */}
      <div className="grid grid-cols-3 gap-4 mb-10">
        {FEATURES.map((f) => (
          // 整张卡片可点击,跳转到对应功能页
          <Link
            key={f.href}
            href={f.href}
            className="card card-hover p-5 block group"
          >
            {/* 图标块:强调色浅底 + 强调色图标 */}
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
              style={{ background: `${f.accent}14`, color: f.accent }}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={f.icon} // 使用配置中的图标 path
                />
              </svg>
            </div>
            {/* 卡片标题 */}
            <div className="text-[15px] font-semibold text-stone-800 mb-1">
              {f.title}
            </div>
            {/* 卡片描述 */}
            <div className="text-[12px] text-stone-500 leading-relaxed">
              {f.desc}
            </div>
            {/* hover 时显示的"进入"提示 */}
            <div className="mt-3 text-[12px] text-orange-700 opacity-0 group-hover:opacity-100 transition">
              进入 →
            </div>
          </Link>
        ))}
      </div>

      {/* ── 最近活动:简历 + 面试 双卡片 ── */}
      <div className="grid grid-cols-2 gap-4">
        {/* 最近简历卡片 */}
        <div className="card p-5">
          {/* 卡片标题行:标题 + "全部"链接 */}
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">最近简历</div>
            <Link
              href="/resumes"
              className="text-[12px] text-stone-500 hover:text-orange-700"
            >
              全部 →
            </Link>
          </div>
          {/* 无简历:空态引导 */}
          {resumes.length === 0 ? (
            <div className="text-[12px] text-stone-400 py-4 text-center">
              还没有简历,
              <Link href="/resumes" className="text-orange-700">
                去创建 →
              </Link>
            </div>
          ) : (
            // 简历列表:姓名 + 求职意向(左) + 更新时间(右)
            <div className="space-y-2">
              {resumes.map((r) => (
                <Link
                  key={r.id}
                  href="/resumes"
                  className="flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-stone-50"
                >
                  <div className="min-w-0">
                    {/* 展示姓名(优先 basics_name,否则用简历名) */}
                    <div className="text-[13px] text-stone-700 truncate">
                      {r.basics_name || r.name}
                    </div>
                    {/* 求职意向(可空,用 — 占位) */}
                    <div className="text-[11px] text-stone-400">
                      {r.basics_title || "—"}
                    </div>
                  </div>
                  {/* 相对更新时间 */}
                  <div className="text-[11px] text-stone-400">
                    {relativeTime(r.updated_at)}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* 最近面试卡片 */}
        <div className="card p-5">
          {/* 卡片标题行 */}
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">最近面试</div>
            <Link
              href="/interview"
              className="text-[12px] text-stone-500 hover:text-orange-700"
            >
              全部 →
            </Link>
          </div>
          {/* 无面试:空态引导 */}
          {interviews.length === 0 ? (
            <div className="text-[12px] text-stone-400 py-4 text-center">
              还没有模拟面试,
              <Link href="/interview" className="text-orange-700">
                开始一场 →
              </Link>
            </div>
          ) : (
            // 面试列表:公司·岗位 + 轮数·状态(左) + 创建时间(右)
            <div className="space-y-2">
              {interviews.map((i) => (
                <Link
                  key={i.id}
                  href="/interview"
                  className="flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-stone-50"
                >
                  <div className="min-w-0">
                    {/* 公司 · 岗位 */}
                    <div className="text-[13px] text-stone-700 truncate">
                      {i.company_name} · {i.job_title}
                    </div>
                    {/* 轮数与状态 */}
                    <div className="text-[11px] text-stone-400">
                      {i.turns} 轮 · {i.status}
                    </div>
                  </div>
                  {/* 相对创建时间 */}
                  <div className="text-[11px] text-stone-400">
                    {relativeTime(i.created_at)}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
