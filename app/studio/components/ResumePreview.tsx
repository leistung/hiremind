"use client"; // 客户端组件:需要访问浏览器 API(图片 URL 拼接等)

// 引入简历数据结构类型与 API 客户端
import type { ResumeData } from "@/lib/types";
import { api } from "@/lib/api";

/** ResumePreview 组件的 props。 */
interface Props {
  data: ResumeData; // 简历数据(表单实时编辑中传入)
  template?: string; // 可选的模板覆盖值;不传则用 data.template
}

/**
 * 简历实时预览组件(入口)。
 *
 * 根据模板标识分发到三套模板渲染器:
 * - "modern"  → ModernPreview(左右分栏 + 橙色强调)
 * - "minimal" → MinimalPreview(极简时间轴)
 * - 其他      → ClassicPreview(经典居中,默认)
 *
 * @param data - 当前简历数据(随表单编辑实时更新)
 * @param template - 模板覆盖;优先级高于 data.template
 */
export default function ResumePreview({ data, template }: Props) {
  // 模板解析:显式传入优先,否则用数据内模板,最后回退 classic
  const tpl = template || data.template || "classic";
  if (tpl === "modern") return <ModernPreview data={data} />; // 现代模板分支
  if (tpl === "minimal") return <MinimalPreview data={data} />; // 极简模板分支
  return <ClassicPreview data={data} />; // 默认经典模板分支
}

// ═══════════════════════ 通用渲染辅助 ═══════════════════════

/**
 * 联系方式行:把电话/邮箱/所在地拼接为一行,以 " · " 分隔。
 * 全部为空时返回 null(不渲染)。
 */
function ContactLine({ data }: { data: ResumeData }) {
  // 过滤出非空字段(电话/邮箱/所在地)
  const parts = [
    data.basics.phone,
    data.basics.email,
    data.basics.location,
  ].filter(Boolean);
  if (parts.length === 0) return null; // 无任何联系方式时不渲染
  return <div className="text-[11px] text-stone-500">{parts.join("  ·  ")}</div>;
}

/**
 * 章节标题:小号大写字母样式 + 下划线,用于各经历区块标题。
 * @param title - 标题文字(如"教育经历")
 * @param color - 强调色(下划线使用其 30% 透明度的浅色版本)
 */
function SectionTitle({ title, color }: { title: string; color: string }) {
  return (
    <div
      className="text-[12px] font-semibold uppercase tracking-wider mb-2 pb-1"
      style={{
        color, // 标题文字色
        borderBottom: `1.5px solid ${color}30`, // 下划线:强调色 + 30% 透明度
      }}
    >
      {title}
    </div>
  );
}

/**
 * 空数据提示:简历所有区块为空时显示的引导文案。
 * 斜体灰色小字,提示用户去左侧填写。
 */
function EmptyHint({ text }: { text: string }) {
  return <div className="text-[11px] text-stone-300 italic">{text}</div>;
}

// ═══════════════════════ 经典模板 ═══════════════════════

/**
 * 经典模板(Classic):居中头部 + 单列纵向布局。
 * 布局:头像+姓名居中 → 个人简介 → 教育 → 工作 → 项目 → 技能。
 */
function ClassicPreview({ data }: { data: ResumeData }) {
  const accent = "#1f2937"; // 经典模板强调色:深灰蓝
  return (
    <div className="bg-white p-8" style={{ minHeight: 400 }}>
      {/* ── 头部:头像 + 姓名 + 职位 + 联系方式(居中) ── */}
      <div className="flex items-center justify-center gap-5 mb-5">
        {/* 有头像时显示圆形头像 */}
        {data.basics.photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={api.assetUrl(data.basics.photo)} // 拼接完整图片 URL
            alt="头像"
            className="w-20 h-20 rounded-full object-cover shrink-0"
            style={{ border: `2px solid ${accent}30` }} // 强调色浅边框
          />
        )}
        {/* 姓名区:有头像时左对齐,否则居中 */}
        <div className={data.basics.photo ? "text-left" : "text-center"}>
          {/* 姓名(空时占位"你的姓名") */}
          <div className="text-2xl font-bold text-stone-800">
            {data.basics.name || "你的姓名"}
          </div>
          {/* 求职意向(可空) */}
          {data.basics.title && (
            <div className="text-[13px] text-stone-500 mt-1">
              {data.basics.title}
            </div>
          )}
          {/* 联系方式行 */}
          <div className="mt-2">
            <ContactLine data={data} />
          </div>
        </div>
      </div>

      {/* ── 个人简介(可空) ── */}
      {data.basics.summary && (
        <div className="mb-4">
          <SectionTitle title="个人简介" color={accent} />
          {/* whitespace-pre-wrap:保留换行 */}
          <div className="text-[12px] text-stone-600 leading-relaxed whitespace-pre-wrap">
            {data.basics.summary}
          </div>
        </div>
      )}

      {/* ── 教育经历(可空) ── */}
      {data.education.length > 0 && (
        <div className="mb-4">
          <SectionTitle title="教育经历" color={accent} />
          {/* 逐条渲染:学校·专业·学历(左) + 时间(右) */}
          {data.education.map((e, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-[12px]">
                {/* 学校 + 专业 + 学历拼接(空字段自动跳过) */}
                <span className="font-medium text-stone-700">
                  {e.school || "学校"}
                  {e.major && ` · ${e.major}`}
                  {e.degree && ` · ${e.degree}`}
                </span>
                {/* 起止时间 */}
                <span className="text-stone-400">
                  {e.start} {e.end && `- ${e.end}`}
                </span>
              </div>
              {/* 在校描述(可空) */}
              {e.description && (
                <div className="text-[11px] text-stone-500 mt-0.5">
                  {e.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 工作经历(可空) ── */}
      {data.experiences.length > 0 && (
        <div className="mb-4">
          <SectionTitle title="工作经历" color={accent} />
          {/* 逐条渲染:公司·职位(左) + 时间(右) */}
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
              {/* 工作描述(可空,保留换行) */}
              {e.description && (
                <div className="text-[11px] text-stone-500 mt-0.5 whitespace-pre-wrap">
                  {e.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 项目经历(可空) ── */}
      {data.projects.length > 0 && (
        <div className="mb-4">
          <SectionTitle title="项目经历" color={accent} />
          {/* 逐条渲染:项目名·角色 + 描述 + 技术栈 */}
          {data.projects.map((p, i) => (
            <div key={i} className="mb-2">
              <div className="text-[12px] font-medium text-stone-700">
                {p.name || "项目名"}
                {p.role && ` · ${p.role}`}
              </div>
              {/* 项目描述(可空,保留换行) */}
              {p.description && (
                <div className="text-[11px] text-stone-500 mt-0.5 whitespace-pre-wrap">
                  {p.description}
                </div>
              )}
              {/* 技术栈(可空,以 " · " 分隔) */}
              {p.tech_stack.length > 0 && (
                <div className="text-[10px] text-stone-400 mt-0.5">
                  技术栈:{p.tech_stack.join(" · ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 技能(可空) ── */}
      {data.skills.length > 0 && (
        <div>
          <SectionTitle title="技能" color={accent} />
          {/* 逐分类渲染:分类名 + 技能项 */}
          {data.skills.map((s, i) => (
            <div key={i} className="text-[12px] text-stone-600 mb-1">
              <span className="text-stone-500">{s.category}:</span>{" "}
              {s.items.join(" · ")}
            </div>
          ))}
        </div>
      )}

      {/* 全空时显示引导提示 */}
      {isEmpty(data) && <EmptyHint text="在左侧填写内容,这里会实时预览" />}
    </div>
  );
}

// ═══════════════════════ 现代模板(左侧栏 + 强调色) ═══════════════════════

/**
 * 现代模板(Modern):左右分栏布局 + 橙色强调色。
 * 左栏(1/3 宽):头像、姓名、联系方式、技能、教育
 * 右栏(2/3 宽):个人简介、工作经历、项目经历
 */
function ModernPreview({ data }: { data: ResumeData }) {
  const accent = "#ea580c"; // 现代模板强调色:品牌橙
  return (
    <div className="bg-white flex" style={{ minHeight: 400 }}>
      {/* ── 左栏:浅橙底 + 右侧橙色分隔线 ── */}
      <div
        className="w-1/3 p-5"
        style={{ background: `${accent}08`, borderRight: `2px solid ${accent}20` }}
      >
        {/* 头像(居中显示,橙色粗边框) */}
        {data.basics.photo && (
          <div className="flex justify-center mb-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={api.assetUrl(data.basics.photo)} // 拼接完整图片 URL
              alt="头像"
              className="w-24 h-24 rounded-full object-cover"
              style={{ border: `3px solid ${accent}` }} // 橙色边框
            />
          </div>
        )}
        {/* 姓名(大号加粗) */}
        <div className="text-xl font-bold text-stone-800 mb-1">
          {data.basics.name || "你的姓名"}
        </div>
        {/* 求职意向(橙色小字) */}
        {data.basics.title && (
          <div className="text-[11px] mb-3" style={{ color: accent }}>
            {data.basics.title}
          </div>
        )}
        {/* 联系方式 */}
        <ContactLine data={data} />

        {/* 技能区(左栏) */}
        {data.skills.length > 0 && (
          <div className="mt-5">
            {/* 橙色大写标题 */}
            <div
              className="text-[11px] font-semibold mb-2 uppercase tracking-wider"
              style={{ color: accent }}
            >
              技能
            </div>
            {/* 逐分类:分类名(灰) + 技能项(深灰) */}
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

        {/* 教育区(左栏) */}
        {data.education.length > 0 && (
          <div className="mt-5">
            <div
              className="text-[11px] font-semibold mb-2 uppercase tracking-wider"
              style={{ color: accent }}
            >
              教育
            </div>
            {/* 逐条:学校(加粗) + 专业学历 + 时间 */}
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

      {/* ── 右栏:主体内容 ── */}
      <div className="flex-1 p-5">
        {/* 个人简介(可空) */}
        {data.basics.summary && (
          <div className="mb-4">
            <SectionTitle title="个人简介" color={accent} />
            <div className="text-[12px] text-stone-600 leading-relaxed whitespace-pre-wrap">
              {data.basics.summary}
            </div>
          </div>
        )}

        {/* 工作经历(可空) */}
        {data.experiences.length > 0 && (
          <div className="mb-4">
            <SectionTitle title="工作经历" color={accent} />
            {/* 逐条:公司·职位(左) + 时间(右) */}
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
                {/* 工作描述(可空,保留换行) */}
                {e.description && (
                  <div className="text-[11px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {e.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 项目经历(可空) */}
        {data.projects.length > 0 && (
          <div>
            <SectionTitle title="项目经历" color={accent} />
            {/* 逐条:项目名·角色 + 描述 + 技术栈标签 */}
            {data.projects.map((p, i) => (
              <div key={i} className="mb-3">
                <div className="text-[12px] font-medium text-stone-700">
                  {p.name}
                  {p.role && ` · ${p.role}`}
                </div>
                {/* 项目描述(可空,保留换行) */}
                {p.description && (
                  <div className="text-[11px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {p.description}
                  </div>
                )}
                {/* 技术栈:橙色浅底标签并排展示 */}
                {p.tech_stack.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {p.tech_stack.map((t, j) => (
                      <span
                        key={j}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: `${accent}14`, // 橙色 14% 透明度浅底
                          color: accent, // 橙色文字
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

        {/* 全空时显示引导提示 */}
        {isEmpty(data) && <EmptyHint text="在左侧填写内容,这里会实时预览" />}
      </div>
    </div>
  );
}

// ═══════════════════════ 极简模板 ═══════════════════════

/**
 * 极简模板(Minimal):大间距 + 细字重 + 时间轴式布局。
 * 经历/项目/教育采用「时间(左) + 内容(右)」的双列网格。
 */
function MinimalPreview({ data }: { data: ResumeData }) {
  const accent = "#0f172a"; // 极简模板强调色:深墨蓝
  return (
    <div className="bg-white p-10" style={{ minHeight: 400 }}>
      {/* ── 头部:姓名(大号细字重) + 头像(右) ── */}
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          {/* 姓名:font-light 细字重,大号 */}
          <div className="text-3xl font-light text-stone-800 tracking-tight">
            {data.basics.name || "你的姓名"}
          </div>
          {/* 求职意向(浅灰小字) */}
          {data.basics.title && (
            <div className="text-[13px] text-stone-400 mt-1">
              {data.basics.title}
            </div>
          )}
          {/* 联系方式 */}
          <div className="mt-3">
            <ContactLine data={data} />
          </div>
        </div>
        {/* 头像(右侧,细边框) */}
        {data.basics.photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={api.assetUrl(data.basics.photo)} // 拼接完整图片 URL
            alt="头像"
            className="w-24 h-24 rounded-full object-cover shrink-0"
            style={{ border: `1.5px solid ${accent}30` }} // 强调色浅边框
          />
        )}
      </div>

      {/* ── 个人简介(左侧竖线装饰) ── */}
      {data.basics.summary && (
        <div className="mb-6 text-[13px] text-stone-600 leading-relaxed whitespace-pre-wrap border-l-2 border-stone-200 pl-4">
          {data.basics.summary}
        </div>
      )}

      {/* ── 经历(时间 + 内容 双列) ── */}
      {data.experiences.length > 0 && (
        <div className="mb-6">
          {/* 区块标题:大写 + 宽字距 */}
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            经历
          </div>
          {/* 逐条:左列时间,右列公司·职位+描述 */}
          {data.experiences.map((e, i) => (
            <div key={i} className="mb-3 grid grid-cols-[120px_1fr] gap-4">
              {/* 时间列(浅灰小字) */}
              <div className="text-[11px] text-stone-400 pt-0.5">
                {e.start}
                {e.end && ` - ${e.end}`}
              </div>
              {/* 内容列 */}
              <div>
                {/* 公司 + 职位(职位为浅灰) */}
                <div className="text-[13px] text-stone-800">
                  {e.company}
                  {e.position && (
                    <span className="text-stone-400"> · {e.position}</span>
                  )}
                </div>
                {/* 描述(可空,保留换行) */}
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

      {/* ── 项目(时间 + 内容 双列) ── */}
      {data.projects.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            项目
          </div>
          {/* 逐条:左列时间,右列项目名·角色+描述+技术栈 */}
          {data.projects.map((p, i) => (
            <div key={i} className="mb-3 grid grid-cols-[120px_1fr] gap-4">
              {/* 时间列 */}
              <div className="text-[11px] text-stone-400 pt-0.5">
                {p.start}
                {p.end && ` - ${p.end}`}
              </div>
              {/* 内容列 */}
              <div>
                {/* 项目名 + 角色 */}
                <div className="text-[13px] text-stone-800">
                  {p.name}
                  {p.role && (
                    <span className="text-stone-400"> · {p.role}</span>
                  )}
                </div>
                {/* 描述(可空,保留换行) */}
                {p.description && (
                  <div className="text-[12px] text-stone-500 mt-1 whitespace-pre-wrap">
                    {p.description}
                  </div>
                )}
                {/* 技术栈(一行小字) */}
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

      {/* ── 教育(时间 + 内容 双列) ── */}
      {data.education.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            教育
          </div>
          {/* 逐条:左列时间,右列学校·专业 */}
          {data.education.map((e, i) => (
            <div key={i} className="mb-2 grid grid-cols-[120px_1fr] gap-4">
              {/* 时间列 */}
              <div className="text-[11px] text-stone-400 pt-0.5">
                {e.start}
                {e.end && ` - ${e.end}`}
              </div>
              {/* 学校 + 专业 */}
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

      {/* ── 技能(单行平铺,全部分类合并) ── */}
      {data.skills.length > 0 && (
        <div>
          <div className="text-[11px] text-stone-400 uppercase tracking-widest mb-3">
            技能
          </div>
          {/* 每个分类的技能项用 " · " 连接,分类之间用 "  ·  " 连接 */}
          <div className="text-[12px] text-stone-600 leading-relaxed">
            {data.skills
              .map((s) => (s.items.length > 0 ? s.items.join(" · ") : s.category))
              .join("  ·  ")}
          </div>
        </div>
      )}

      {/* 全空时显示引导提示 */}
      {isEmpty(data) && <EmptyHint text="在左侧填写内容,这里会实时预览" />}
    </div>
  );
}

/**
 * 判断简历数据是否完全为空(所有区块均无内容)。
 * 用于在预览区显示引导提示文案。
 * @param data - 简历数据
 * @returns 是否为空(姓名/简介为空 且 教育/工作/项目/技能列表全空)
 */
function isEmpty(data: ResumeData): boolean {
  return (
    !data.basics.name && // 姓名为空
    !data.basics.summary && // 简介为空
    data.education.length === 0 && // 教育列表为空
    data.experiences.length === 0 && // 工作列表为空
    data.projects.length === 0 && // 项目列表为空
    data.skills.length === 0 // 技能列表为空
  );
}
