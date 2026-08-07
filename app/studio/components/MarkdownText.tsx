"use client";

import { useMemo } from "react";

/**
 * 轻量 Markdown 渲染(无第三方依赖).
 * 只处理 LLM 回答最常见的格式:代码块、标题、粗体、行内代码、
 * 无序/有序列表、段落、换行。用于 Ask 助手等对话场景。
 *
 * 通过 dangerouslySetInnerHTML 输出,内容来自模型输出,
 * 已做基本转义,不存在用户可控的 HTML 注入。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 行内格式:粗体、斜体、行内代码 */
function renderInline(s: string): string {
  let out = escapeHtml(s);
  // 还原模型可能使用的 <br /> 换行(escapeHtml 已转为 &lt;br /&gt;)
  out = out.replace(/&lt;br\s*\/?&gt;/gi, "<br />");
  // 行内代码 `code`
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 粗体 **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 斜体 *text*(在粗体之后处理,避免冲突)
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  return out;
}

/** 拆分表格行为单元格(去掉首尾的 |,按 | 切分,trim 每个 cell) */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  // 去掉首尾的 |
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function markdownToHtml(md: string): string {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  // 列表状态
  let listType: "ul" | "ol" | null = null;

  function closeList() {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // ── 代码块 ──
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        closeList();
        inCodeBlock = true;
        codeLang = fenceMatch[1] || "";
        codeBuf = [];
      } else {
        // 结束代码块
        const code = escapeHtml(codeBuf.join("\n"));
        html.push(
          `<pre class="md-code-block"><code${codeLang ? ` class="lang-${codeLang}"` : ""}>${code}</code></pre>`,
        );
        inCodeBlock = false;
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCodeBlock) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // ── 空行 ──
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // ── 标题 ──
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // ── 引用块 ──
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      closeList();
      html.push(`<blockquote>${renderInline(quoteMatch[1])}</blockquote>`);
      i++;
      continue;
    }

    // ── 无序列表 ──
    const ulMatch = line.match(/^[\s]*[-*+]\s+(.*)$/);
    if (ulMatch) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInline(ulMatch[1])}</li>`);
      i++;
      continue;
    }

    // ── 有序列表 ──
    const olMatch = line.match(/^[\s]*\d+\.\s+(.*)$/);
    if (olMatch) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInline(olMatch[1])}</li>`);
      i++;
      continue;
    }

    // ── 水平线 ──
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      html.push("<hr />");
      i++;
      continue;
    }

    // ── 表格 ──(GFM 语法:表头行 + 分隔行 + 数据行)
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      closeList();
      const tableLines: string[] = [];
      let k = i;
      // 收集连续的表格行
      while (k < lines.length && /\|/.test(lines[k]) && lines[k].trim() !== "") {
        tableLines.push(lines[k]);
        k++;
      }
      if (tableLines.length >= 2) {
        // 解析表头
        const headerCells = splitTableRow(tableLines[0]);
        // 跳过分隔行(tableLines[1])
        const bodyRows = tableLines.slice(2).map(splitTableRow);
        html.push("<table>");
        html.push(
          "<thead><tr>" +
            headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("") +
            "</tr></thead>",
        );
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
        i = k;
        continue;
      }
    }

    // ── 普通段落 ──
    closeList();
    // 收集连续非空非特殊行作为同一段落
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
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
    html.push(`<p>${renderInline(paraLines.join("\n").replace(/\n/g, "<br />"))}</p>`);
    i = j;
  }

  // 收尾
  if (inCodeBlock) {
    // 未闭合的代码块:原样输出
    html.push(
      `<pre class="md-code-block"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
    );
  }
  closeList();

  return html.join("\n");
}

export default function MarkdownText({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  const html = useMemo(() => markdownToHtml(content || ""), [content]);
  return (
    <div
      className={`prose-warm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
