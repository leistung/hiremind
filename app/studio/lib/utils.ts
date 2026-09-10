/**
 * lib/utils.ts —— 前端通用工具函数
 *
 * 提供日期格式化、相对时间、评分配色、严重度归一化、文件下载、
 * 简历空数据初始化等与业务无关的纯函数。
 * 除 downloadBlob / downloadReport 涉及浏览器 DOM 操作外,
 * 其余函数均为纯函数,可被任意页面与组件复用。
 */

/**
 * 将 ISO 时间字符串格式化为「YYYY-MM-DD HH:mm」的本地时间显示。
 * @param iso - ISO 8601 时间字符串(如 "2026-09-04T10:30:00Z");为空则返回空串
 * @returns 格式化后的时间字符串;解析失败时原样返回输入
 */
export function formatDate(iso: string): string {
  if (!iso) return ""; // 空输入直接返回空串,避免 new Date("") 产生 Invalid Date
  try {
    const d = new Date(iso); // 解析 ISO 字符串为 Date 对象
    if (isNaN(d.getTime())) return iso; // 非法日期(如 "abc")则原样返回,不强行格式化
    // 逐段拼接并补零:年-月-日 时:分,月/日/时/分均用 padStart 补足两位
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  } catch {
    return iso; // 极端解析异常时兜底返回原始字符串,保证不抛错
  }
}

/**
 * 计算 ISO 时间相对当前的「刚刚 / N 分钟前 / N 小时前 / N 天前」描述,
 * 超过 30 天则回退为具体日期(formatDate 的日期部分)。
 * @param iso - ISO 时间字符串
 * @returns 相对时间描述字符串;解析失败时原样返回输入
 */
export function relativeTime(iso: string): string {
  if (!iso) return ""; // 空输入返回空串
  try {
    const d = new Date(iso); // 解析目标时间
    const now = Date.now(); // 当前时间戳(毫秒)
    const diff = now - d.getTime(); // 与当前的时间差(毫秒)
    const min = Math.floor(diff / 60000); // 换算为分钟(60000ms = 1 分钟)
    if (min < 1) return "刚刚"; // 不足 1 分钟视为"刚刚"
    if (min < 60) return `${min} 分钟前`; // 1 分钟 ~ 1 小时显示分钟数
    const hour = Math.floor(min / 60); // 换算为小时
    if (hour < 24) return `${hour} 小时前`; // 1 小时 ~ 24 小时显示小时数
    const day = Math.floor(hour / 24); // 换算为天
    if (day < 30) return `${day} 天前`; // 1 天 ~ 30 天显示天数
    return formatDate(iso).split(" ")[0]; // 超过 30 天显示具体日期(截掉时间部分)
  } catch {
    return iso; // 解析失败兜底返回原始字符串
  }
}

/**
 * 根据分数占比映射到语义化状态色 class 名(供 Tailwind / 自定义样式使用)。
 * @param score - 实际得分
 * @param max - 分数满分,默认 100
 * @returns "success"(得分率 ≥80%) | "warning"(≥60%) | "danger"(<60%)
 */
export function scoreColor(score: number, max = 100): string {
  const ratio = score / max; // 归一化到 0~1 的得分率
  if (ratio >= 0.8) return "success"; // 80% 以上 → 绿色(优秀/通过)
  if (ratio >= 0.6) return "warning"; // 60%~80% → 黄色(及格/需注意)
  return "danger"; // 低于 60% → 红色(危险/不通过)
}

/**
 * 将后端返回的风险严重度文本归一化为统一枚举值。
 * 兼容中文(高/中/低)与英文(high/mid/low)两种写法。
 * @param sev - 原始严重度字符串
 * @returns "high" | "mid" | "low",无法识别时默认归为 "low"
 */
export function severityLevel(sev: string): "high" | "mid" | "low" {
  const s = sev.toLowerCase(); // 统一转小写,便于关键词匹配
  if (s.includes("高") || s.includes("high")) return "high"; // 命中"高"或"high"
  if (s.includes("中") || s.includes("mid")) return "mid"; // 命中"中"或"mid"
  return "low"; // 其余(含"低"/"low"/空串)统一归为 low
}

/**
 * 触发浏览器下载一个 Blob 对象。
 * 原理:为 Blob 创建临时对象 URL,挂载一个临时 <a download> 标签并模拟点击,
 * 下载指令发出后立即清理标签与对象 URL,避免内存泄漏。
 * @param blob - 要下载的二进制数据
 * @param filename - 下载文件的保存名
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); // 为 Blob 创建临时对象 URL
  const a = document.createElement("a"); // 创建临时 <a> 标签
  a.href = url; // 链接指向对象 URL
  a.download = filename; // 设置浏览器下载时的文件名
  document.body.appendChild(a); // 标签需挂载到 DOM 才能触发 click 事件
  a.click(); // 模拟点击,触发浏览器下载
  document.body.removeChild(a); // 下载指令已发出,移除临时标签
  setTimeout(() => URL.revokeObjectURL(url), 1000); // 延迟释放对象 URL,防止资源占用
}

/**
 * 通过 fetch 拉取远端文件并触发下载;下载失败时回退为新窗口打开。
 * 用于报告导出等"后端先生成文件、前端再下载"的场景。
 * @param filename - 保存到本地的文件名
 * @param downloadUrl - 文件下载的完整 URL
 */
export async function downloadReport(filename: string, downloadUrl: string) {
  try {
    const res = await fetch(downloadUrl); // 请求文件二进制内容
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // 非 2xx 响应视为失败
    const blob = await res.blob(); // 提取响应体为 Blob
    downloadBlob(blob, filename); // 走通用 Blob 下载流程
  } catch (e) {
    window.open(downloadUrl, "_blank"); // 下载失败(如超时/跨域)时新窗口打开兜底
  }
}

/**
 * 返回一份全新的空简历数据(与后端 ResumeData schema 对齐)。
 * 供"手动新建简历"场景初始化表单与右侧实时预览使用。
 * @returns 所有字段为空的 ResumeData;数组字段为空数组,模板默认 "classic"
 */
export function emptyResumeData() {
  return {
    basics: {
      name: "", // 姓名
      phone: "", // 联系电话
      email: "", // 邮箱
      location: "", // 所在地
      title: "", // 求职意向 / 职位头衔
      summary: "", // 个人简介
      photo: "", // 头像(存储路径或完整 URL)
    },
    education: [], // 教育经历列表(初始为空)
    experiences: [], // 工作经历列表(初始为空)
    projects: [], // 项目经历列表(初始为空)
    skills: [], // 技能分类列表(初始为空)
    template: "classic", // 默认使用 Classic 模板
  };
}
