"use client";

import type { ResumeData } from "@/lib/types";
import { api } from "@/lib/api";

interface Props {
  data: ResumeData;
  template?: string;
}

export default function ResumePreview({ data, template }: Props) {
  const tpl = template || data.template || "classic";
  if (tpl === "modern") return <ModernPreview data={data} />;
  if (tpl === "minimal") return <MinimalPreview data={data} />;
  return <ClassicPreview data={data} />;
}

// ── 通用渲染辅助 ──

function ContactLine({ data }: { data: ResumeData }) {
  const parts = [
    data.basics.phone,
    data.basics.email,
    data.basics.location,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <div className="text-[11px] text-stone-500">{parts.join("  ·  ")}</div>;
}

function SectionTitle({ title, color }: { title: string; color: string }) {
  return (
    <div
      className="text-[12px] font-semibold uppercase tracking-wider mb-2 pb-1"
      style={{
        color,
        borderBottom: `1.5px solid ${color}30`,
      }}
    >
      {title}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="text-[11px] text-stone-300 italic">{text}</div>;
}

// ── 经典模板 ──

function ClassicPreview({ data }: { data: ResumeData }) {
  const accent = "#1f2937";
  return (
    <div className="bg-white p-8" style={{ minHeight: 400 }}>
      <div className="flex items-center justify-center gap-5 mb-5">
        {data.basics.photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={api.assetUrl(data.basics.photo)}
            alt="头像"
            className="w-20 h-20 rounded-full object-cover shrink-0"
            style={{ border: `2px solid ${accent}30` }}
          />
        )}
        <div className={data.basics.photo ? "text-left" : "text-center"}>
          <div className="text-2xl font-bold text-stone-800">
            {data.basics.name || "你的姓名"}
          </div>
          {data.basics.title && (
            <div className="text-[13px] text-stone-500 mt-1">
              {data.basics.title}
            </div>
          )}
          <div className="mt-2">
            <ContactLine data={data} />
          </div>
        </div>
      </div>

      {data.basics.summary && (
        <div className="mb-4">
          <SectionTitle title="个人简介" color={accent} />
          <div className="text-[12px] text-stone-600 leading-relaxed whitespace-pre-wrap">
            {data.basics.summary}
          </div>
        </div>
      )}

      {data.education.length > 0 && (
        <div className="mb-4">
          <SectionTitle title="教育经历" color={accent} />
          {data.education.map((e, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-[12px]">
                <span className="font-medium text-stone-700">
                  {e.school || "学校"}
                  {e.major && ` · ${e.major}`}
                  {e.degree && ` · ${e.degree}`}
                </span>
                <span className="text-stone-400">
                  {e.start} {e.end && `- ${e.end}`}
                </span>
              </div>
              {e.description && (
                <div className="text-[11px] text-stone-500 mt-0.5">
                  {e.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.experiences.length > 0 && (
        <div className="mb-4">
          <SectionTitle title="工作经历" color={accent} />
          {data.experiences.map((e, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-[12px]">
                <span className="font-medium text-stone-700">
                  {e.company || "公司"}
                  {e.position && ` · ${e.position}`}
                </span>
                <span className="text-stone-400">
                  {e.start} {e.end && `- ${e.end}`}
                </span>
              </div>
              {e.description && (
                <div className="text-[11px] text-stone-500 mt-0.5 whitespace-pre-wrap">
                  {e.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.projects.length > 0 && (
        <div className="mb-4">
          <SectionTitle title="项目经历" color={accent} />
          {data.projects.map((p, i) => (
            <div key={i} className="mb-2">
              <div className="text-[12px] font-medium text-stone-700">
                {p.name || "项目名"}
                {p.role && ` · ${p.role}`}
              </div>
              {p.description && (
                <div className="text-[11px] text-stone-500 mt-0.5 whitespace-pre-wrap">
                  {p.description}
                </div>
              )}
              {p.tech_stack.length > 0 && (
                <div className="text-[10px] text-stone-400 mt-0.5">
                  技术栈:{p.tech_stack.join(" · ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.skills.length > 0 && (
        <div>
          <SectionTitle title="技能" color={accent} />
          {data.skills.map((s, i) => (
            <div key={i} className="text-[12px] text-stone-600 mb-1">
              <span className="text-stone-500">{s.category}:</span>{" "}
              {s.items.join(" · ")}
            </div>
          ))}
        </div>
      )}

      {isEmpty(data) && <EmptyHint text="在左侧填写内容,这里会实时预览" />}
    </div>
  );
}

// ── 现代模板(左侧栏 + 强调色)──

function ModernPreview({ data }: { data: ResumeData }) {
  const accent = "#ea580c";
  return (
    <div className="bg-white flex" style={{ minHeight: 400 }}>
      {/* 左栏 */}
      <div
        className="w-1/3 p-5"
        style={{ background: `${accent}08`, borderRight: `2px solid ${accent}20` }}
      >
        {data.basics.photo && (
          <div className="flex justify-center mb-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={api.assetUrl(data.basics.photo)}
              alt="头像"
              className="w-24 h-24 rounded-full object-cover"
              style={{ border: `3px solid ${accent}` }}
            />
          </div>
        )}
        <div className="text-xl font-bold text-stone-800 mb-1">
          {data.basics.name || "你的姓名"}
        </div>
        {data.basics.title && (
          <div className="text-[11px] mb-3" style={{ color: accent }}>
            {data.basics.title}
          </div>
        )}
        <ContactLine data={data} />

        {data.skills.length > 0 && (
          <div className="mt-5">
            <div
              className="text-[11px] font-semibold mb-2 uppercase tracking-wider"
              style={{ color: accent }}
            >
              技能
            </div>
            {data.skills.map((s, i) => (
              <div key={i} className="mb-1.5">
                <div className="text-[10px] text-stone-500">{s.category}</div>
                <div className="text-[11px] text-stone-700">
                  {s.items.join(" · ")}
                </div>
              </div>
            ))}
          </div>
        )}

        {data.education.length > 0 && (
          <div className="mt-5">
            <div
              className="text-[11px] font-semibold mb-2 uppercase tracking-wider"
              style={{ color: accent }}
            >
              教育
            </div>
            {data.education.map((e, i) => (
              <div key={i} className="mb-2">
                <div className="text-[11px] font-medium text-stone-700">
                  {e.school}
                </div>
                <div className="text-[10px] text-stone-500">
                  {e.major} {e.degree}
                </div>
                <div className="text-[10px] text-stone-400">
                  {e.start} {e.end && `- ${e.end}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右栏 */}
      <div className="flex-1 p-5">
        {data.basics.summary && (
          <div className="mb-4">
            <SectionTitle title="个人简介" color={accent} />
            <div className="text-[12px] text-stone-600 leading-relaxed whitespace-pre-wrap">
              {data.basics.summary}
            </div>
          </div>
        )}

        {data.experiences.length > 0 && (
          <div className="mb-4">
            <SectionTitle title="工作经历" color={accent} />
            {data.experiences.map((e, i) => (
              <div key={i} className="mb-3">
                <div className="flex justify-between text-[12px]">
                  <span className="font-medium text-stone-700">
                    {e.company}
                    {e.position && ` · ${e.position}`}
                  </span>
                  <span className="text-stone-400 text-[11px]">
                    {e.start} {e.end && `- ${e.end}`}
                  </span>
                </div>
                {e.description && (
                  <div className="text-[11px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {e.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {data.projects.length > 0 && (
          <div>
            <SectionTitle title="项目经历" color={accent} />
            {data.projects.map((p, i) => (
              <div key={i} className="mb-3">
                <div className="text-[12px] font-medium text-stone-700">
                  {p.name}
                  {p.role && ` · ${p.role}`}
                </div>
                {p.description && (
                  <div className="text-[11px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {p.description}
                  </div>
                )}
                {p.tech_stack.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.tech_stack.map((t, j) => (
                      <span
                        key={j}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: `${accent}14`,
                          color: accent,
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {isEmpty(data) && <EmptyHint text="在左侧填写内容,这里会实时预览" />}
      </div>
    </div>
  );
}

// ── 极简模板 ──

function MinimalPreview({ data }: { data: ResumeData }) {
  const accent = "#0f172a";
  return (
    <div className="bg-white p-10" style={{ minHeight: 400 }}>
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="text-3xl font-light text-stone-800 tracking-tight">
            {data.basics.name || "你的姓名"}
          </div>
          {data.basics.title && (
            <div className="text-[13px] text-stone-400 mt-1">
              {data.basics.title}
            </div>
          )}
          <div className="mt-3">
            <ContactLine data={data} />
          </div>
        </div>
        {data.basics.photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={api.assetUrl(data.basics.photo)}
            alt="头像"
            className="w-24 h-24 rounded-full object-cover shrink-0"
            style={{ border: `1.5px solid ${accent}30` }}
          />
        )}
      </div>

      {data.basics.summary && (
        <div className="mb-6 text-[13px] text-stone-600 leading-relaxed whitespace-pre-wrap border-l-2 border-stone-200 pl-4">
          {data.basics.summary}
        </div>
      )}

      {data.experiences.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            经历
          </div>
          {data.experiences.map((e, i) => (
            <div key={i} className="mb-3 grid grid-cols-[120px_1fr] gap-4">
              <div className="text-[11px] text-stone-400 pt-0.5">
                {e.start}
                {e.end && ` - ${e.end}`}
              </div>
              <div>
                <div className="text-[13px] text-stone-800">
                  {e.company}
                  {e.position && (
                    <span className="text-stone-400"> · {e.position}</span>
                  )}
                </div>
                {e.description && (
                  <div className="text-[12px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {e.description}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.projects.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            项目
          </div>
          {data.projects.map((p, i) => (
            <div key={i} className="mb-3 grid grid-cols-[120px_1fr] gap-4">
              <div className="text-[11px] text-stone-400 pt-0.5">
                {p.start}
                {p.end && ` - ${p.end}`}
              </div>
              <div>
                <div className="text-[13px] text-stone-800">
                  {p.name}
                  {p.role && (
                    <span className="text-stone-400"> · {p.role}</span>
                  )}
                </div>
                {p.description && (
                  <div className="text-[12px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {p.description}
                  </div>
                )}
                {p.tech_stack.length > 0 && (
                  <div className="text-[11px] text-stone-400 mt-1">
                    {p.tech_stack.join(" · ")}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.education.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            教育
          </div>
          {data.education.map((e, i) => (
            <div key={i} className="mb-2 grid grid-cols-[120px_1fr] gap-4">
              <div className="text-[11px] text-stone-400 pt-0.5">
                {e.start}
                {e.end && ` - ${e.end}`}
              </div>
              <div className="text-[13px] text-stone-700">
                {e.school}
                {e.major && (
                  <span className="text-stone-400"> · {e.major}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.skills.length > 0 && (
        <div>
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            技能
          </div>
          <div className="text-[12px] text-stone-600 leading-relaxed">
            {data.skills
              .map((s) => (s.items.length > 0 ? s.items.join(" · ") : s.category))
              .join("  ·  ")}
          </div>
        </div>
      )}

      {isEmpty(data) && <EmptyHint text="在左侧填写内容,这里会实时预览" />}
    </div>
  );
}

function isEmpty(data: ResumeData): boolean {
  return (
    !data.basics.name &&
    !data.basics.summary &&
    data.education.length === 0 &&
    data.experiences.length === 0 &&
    data.projects.length === 0 &&
    data.skills.length === 0
  );
}
