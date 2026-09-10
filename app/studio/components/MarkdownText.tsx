"use client"; // 客户端组件

import { useMemo } from "react";

/**
 * 轻量 Markdown 渲染组件(无第三方依赖)。
 *
 * 只处理 LLM 回答最常见的格式:代码块、标题、粗体、行内代码、
 * 无序/有序列表、段落、引用、表格、换行。用于 Ask 助手等对话场景。
 *
 * 渲染原理:把 markdown 文本逐行解析为 HTML 字符串,
 * 通过 dangerouslySetInnerHTML 输出。
 * 内容来自模型输出,已做 HTML 转义,不存在用户可控的注入风险。
 */

/**
 * HTML 转义:把特殊字符替换为实体,防止内容被当作 HTML 标签解析。
 * @param s - 原始字符串
 * @returns 转义后的字符串(& < > " ' 均被替换)
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;") // & 必须最先转义,否则后续实体被二次转义
    .replace(/</g, "&lt;") // < 转义,防止标签注入
    .replace(/>/g, "&gt;") // > 转义
    .replace(/"/g, "&quot;") // 双引号转义
    .replace(/'/g, "&#39;"); // 单引号转义
}

/**
 * 渲染行内格式:粗体、斜体、行内代码、<br> 换行。
 * 先转义再逐类替换,顺序敏感(斜体需在粗体之后处理避免冲突)。
 * @param s - 行内文本(未转义)
 * @returns 转义 + 格式化后的 HTML 片段
 */
function renderInline(s: string): string {
  let out = escapeHtml(s); // 先整体转义,杜绝注入
  // 还原模型可能使用的 <br /> 换行(此时已被 escapeHtml 转为 &lt;br /&gt;)
  out = out.replace(/&lt;br\s*\/?&gt;/gi, "<br />");
  // 行内代码 `code` → <code> 标签
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 粗体 **text** → <strong> 标签
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 斜体 *text*(在粗体之后处理,避免把 ** 拆成斜体)
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  return out;
}

/**
 * 拆分表格行为单元格数组。
 * 去掉首尾的 "|",按 "|" 切分,并对每个单元格 trim 空白。
 * @param line - 原始表格行(如 "| 姓名 | 分数 |")
 * @returns 单元格字符串数组
 */
function splitTableRow(line: string): string[] {
  let s = line.trim(); // 去掉行首尾空白
  // 去掉行首的 "|"(GFM 表格行常以 | 开头)
  if (s.startsWith("|")) s = s.slice(1);
  // 去掉行尾的 "|"
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim()); // 按 | 切分并 trim 每个单元格
}

/**
 * 核心解析器:把 Markdown 文本转换为 HTML 字符串。
 *
 * 采用"逐行扫描 + 状态机"实现:
 * - 代码块状态(inCodeBlock):遇到 ``` 进入/退出,内部行原样累积
 * - 列表状态(listType):记录当前 ul/ol,连续列表行归入同一标签
 * @param md - 原始 Markdown 文本
 * @returns HTML 字符串(多行拼接)
 */
function markdownToHtml(md: string): string {
  if (!md) return ""; // 空文本直接返回空串
  // 统一换行符为 \n 并拆分为行数组
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = []; // 输出的 HTML 片段累积器
  let i = 0; // 当前扫描行下标
  let inCodeBlock = false; // 是否处于代码块内部
  let codeLang = ""; // 当前代码块的语言标识(``` 后跟的语言名)
  let codeBuf: string[] = []; // 代码块内容行缓冲
  // 列表状态:当前打开的列表类型(ul/ol),用于合并连续列表项
  let listType: "ul" | "ol" | null = null;

  /** 关闭当前打开的列表标签(如 <ul>...</ul>),并重置状态。 */
  function closeList() {
    if (listType) {
      html.push(`</${listType}>`); // 输出闭合标签
      listType = null; // 重置列表状态
    }
  }

  // ── 主循环:逐行解析 ──
  while (i < lines.length) {
    const line = lines[i];

    // ── 代码块围栏(``` 开头) ──
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        // 进入代码块:先关闭可能打开的列表,记录语言,开始累积
        closeList();
        inCodeBlock = true;
        codeLang = fenceMatch[1] || ""; // 语言标识(可能为空)
        codeBuf = [];
      } else {
        // 退出代码块:转义内容并输出 <pre><code> 结构
        const code = escapeHtml(codeBuf.join("\n")); // 转义防注入
        html.push(
          `<pre class="md-code-block"><code${codeLang ? ` class="lang-${codeLang}"` : ""}>${code}</code></pre>`,
        );
        inCodeBlock = false; // 退出代码块状态
        codeBuf = [];
      }
      i++; // 移动到下一行
      continue;
    }
    // 代码块内部的行:原样累积,不做任何格式解析
    if (inCodeBlock) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // ── 空行:结束当前段落/列表,跳过 ──
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // ── 标题(# 1-4 级) ──
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      closeList(); // 标题前关闭列表
      const level = headingMatch[1].length; // # 数量即标题级别
      html.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // ── 引用块(> 开头) ──
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      closeList();
      html.push(`<blockquote>${renderInline(quoteMatch[1])}</blockquote>`);
      i++;
      continue;
    }

    // ── 无序列表(- * + 开头) ──
    const ulMatch = line.match(/^[\s]*[-*+]\s+(.*)$/);
    if (ulMatch) {
      // 若当前不是 ul,先关闭旧列表再开新 <ul>
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInline(ulMatch[1])}</li>`);
      i++;
      continue;
    }

    // ── 有序列表(数字. 开头) ──
    const olMatch = line.match(/^[\s]*\d+\.\s+(.*)$/);
    if (olMatch) {
      // 若当前不是 ol,先关闭旧列表再开新 <ol>
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInline(olMatch[1])}</li>`);
      i++;
      continue;
    }

    // ── 水平线(--- / *** / ___) ──
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      html.push("<hr />");
      i++;
      continue;
    }

    // ── 表格(GFM 语法:表头行 + 分隔行 + 数据行) ──
    // 判定条件:本行含 |,下一行是 | 组成的对齐分隔行
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      closeList();
      const tableLines: string[] = [];
      let k = i;
      // 收集连续的所有表格行(含 | 且非空)
      while (k < lines.length && /\|/.test(lines[k]) && lines[k].trim() !== "") {
        tableLines.push(lines[k]);
        k++;
      }
      if (tableLines.length >= 2) {
        // 解析表头(第一行)
        const headerCells = splitTableRow(tableLines[0]);
        // 跳过分隔行(tableLines[1]),数据行从第三行起
        const bodyRows = tableLines.slice(2).map(splitTableRow);
        html.push("<table>");
        // 表头:每个单元格渲染为 <th>
        html.push(
          "<thead><tr>" +
            headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("") +
            "</tr></thead>",
        );
        // 表体:每行渲染为 <tr><td>...</td></tr>
        if (bodyRows.length > 0) {
          html.push(
            "<tbody>" +
              bodyRows
                .map(
                  (row) =>
                    "<tr>" +
                    row.map((c) => `<td>${renderInline(c)}</td>`).join("") +
                    "</tr>",
                )
                .join("") +
              "</tbody>",
          );
        }
        html.push("</table>");
        i = k; // 跳过已消费的表格行
        continue;
      }
    }

    // ── 普通段落 ──
    closeList(); // 段落前关闭列表
    // 收集连续的非空、非特殊行作为同一段落(内部用 <br> 换行)
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      // 遇到空行/代码块/标题/引用/列表/分隔线/表格行即结束段落
      if (
        next.trim() === "" ||
        /^```/.test(next) ||
        /^(#{1,4})\s+/.test(next) ||
        /^>\s?/.test(next) ||
        /^[\s]*[-*+]\s+/.test(next) ||
        /^[\s]*\d+\.\s+/.test(next) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(next) ||
        // 表格行(含 | 的行单独成段,不并入段落)
        /\|/.test(next)
      ) {
        break;
      }
      paraLines.push(next);
      j++;
    }
    // 段落内换行转为 <br />,保持多行可读性
    html.push(`<p>${renderInline(paraLines.join("\n").replace(/\n/g, "<br />"))}</p>`);
    i = j; // 跳到段落结束处
  }

  // ── 收尾处理 ──
  if (inCodeBlock) {
    // 未闭合的代码块(文件结束仍处于代码块内):原样输出,不丢弃内容
    html.push(
      `<pre class="md-code-block"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
    );
  }
  closeList(); // 关闭可能遗留的列表标签

  return html.join("\n"); // 所有片段拼接为最终 HTML
}

/**
 * MarkdownText 组件:把 markdown 内容渲染为富文本。
 * 使用 useMemo 缓存解析结果,避免每次渲染重复解析。
 * @param content - 原始 Markdown 字符串
 * @param className - 附加的 CSS 类名(默认使用 prose-warm 排版样式)
 */
export default function MarkdownText({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  // 仅当 content 变化时才重新解析,提升渲染性能
  const html = useMemo(() => markdownToHtml(content || ""), [content]);
  return (
    // 通过 dangerouslySetInnerHTML 注入解析后的 HTML(已做转义,安全)
    <div
      className={`prose-warm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
