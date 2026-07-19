"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { InterviewListItem, ResumeListItem } from "@/lib/types";
import { relativeTime } from "@/lib/utils";

const FEATURES = [
  {
    href: "/resumes",
    title: "简历",
    desc: "在线编辑简历,选择模板,一键导出 Word / PDF",
    icon: "M9 12h6m-6 4h6m-6-8h6M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z",
    accent: "#c2410c",
  },
  {
    href: "/analysis",
    title: "面试分析",
    desc: "输入 JD 与简历,生成匹配度、改进点、面试题与参考答案",
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    accent: "#b45309",
  },
  {
    href: "/interview",
    title: "模拟面试",
    desc: "基于分析报告进行 AI 自适应提问,生成评估与学习建议",
    icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
    accent: "#15803d",
  },
];

export default function HomePage() {
  const [resumes, setResumes] = useState<ResumeListItem[]>([]);
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);

  useEffect(() => {
    Promise.all([api.listResumes(), api.listInterviews()])
      .then(([r, i]) => {
        setResumes((r.resumes || []).slice(0, 3));
        setInterviews((i.interviews || []).slice(0, 3));
      })
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-8 py-12">
      {/* Hero */}
      <div className="mb-10">
        <div className="badge badge-accent mb-3">v0.3 · 暖色文档风</div>
        <h1 className="text-3xl font-semibold text-stone-800 tracking-tight mb-3">
          让每一次面试都有备而来
        </h1>
        <p className="text-stone-500 text-[15px] leading-relaxed max-w-2xl">
          HireMind 是一个 AI 驱动的面试准备平台:结构化简历编辑、JD × 简历深度分析、
          自适应模拟面试,从准备到实战完整覆盖。
        </p>
      </div>

      {/* 功能卡片 */}
      <div className="grid grid-cols-3 gap-4 mb-10">
        {FEATURES.map((f) => (
          <Link
            key={f.href}
            href={f.href}
            className="card card-hover p-5 block group"
          >
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
                  d={f.icon}
                />
              </svg>
            </div>
            <div className="text-[15px] font-semibold text-stone-800 mb-1">
              {f.title}
            </div>
            <div className="text-[12px] text-stone-500 leading-relaxed">
              {f.desc}
            </div>
            <div className="mt-3 text-[12px] text-orange-700 opacity-0 group-hover:opacity-100 transition">
              进入 →
            </div>
          </Link>
        ))}
      </div>

      {/* 最近活动 */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">最近简历</div>
            <Link
              href="/resumes"
              className="text-[12px] text-stone-500 hover:text-orange-700"
            >
              全部 →
            </Link>
          </div>
          {resumes.length === 0 ? (
            <div className="text-[12px] text-stone-400 py-4 text-center">
              还没有简历,
              <Link href="/resumes" className="text-orange-700">
                去创建 →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {resumes.map((r) => (
                <Link
                  key={r.id}
                  href="/resumes"
                  className="flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-stone-50"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] text-stone-700 truncate">
                      {r.basics_name || r.name}
                    </div>
                    <div className="text-[11px] text-stone-400">
                      {r.basics_title || "—"}
                    </div>
                  </div>
                  <div className="text-[11px] text-stone-400">
                    {relativeTime(r.updated_at)}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">最近面试</div>
            <Link
              href="/interview"
              className="text-[12px] text-stone-500 hover:text-orange-700"
            >
              全部 →
            </Link>
          </div>
          {interviews.length === 0 ? (
            <div className="text-[12px] text-stone-400 py-4 text-center">
              还没有模拟面试,
              <Link href="/interview" className="text-orange-700">
                开始一场 →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {interviews.map((i) => (
                <Link
                  key={i.id}
                  href="/interview"
                  className="flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-stone-50"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] text-stone-700 truncate">
                      {i.company_name} · {i.job_title}
                    </div>
                    <div className="text-[11px] text-stone-400">
                      {i.turns} 轮 · {i.status}
                    </div>
                  </div>
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
