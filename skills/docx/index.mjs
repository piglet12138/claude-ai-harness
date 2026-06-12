// ===========================================================================
// docx skill — long-document generation + Markdown→DOCX export.
// Extracted from server.mjs (strangler refactor). This is the self-contained
// home for document generation; future upgrades (format rules, validation, QA)
// happen here without touching the server core.
// ===========================================================================
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { braveApiKey } from "../../lib/config.mjs";
import { longDocJobs } from "../../lib/state.mjs";
import { callClaude } from "../../lib/llm.mjs";
import { braveSearch } from "../../tools/web.mjs";
import { delay } from "../../lib/util.mjs";

const require = createRequire(import.meta.url);
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
        TableRow, TableCell, Table, WidthType, BorderStyle } = require("docx");

export { Packer };

// ---------------------------------------------------------------------------
// Long document generation — multi-agent parallel chapter writing
// ---------------------------------------------------------------------------
function buildOutlinePrompt(topic, requirements, targetPages, format) {
  const chaptersEstimate = Math.max(3, Math.min(15, Math.round(targetPages / 6)));
  return `你是一位专业的文档架构师。请为以下主题设计一份详细的文档大纲。

主题：${topic}
${requirements ? `额外要求：${requirements}` : ""}
目标页数：约${targetPages}页
章节数量建议：${chaptersEstimate}章左右

请严格按照以下 JSON 格式输出（不要添加任何其他文字）：
\`\`\`json
{
  "title": "文档标题",
  "abstract": "100字以内的摘要",
  "chapters": [
    {
      "title": "章节标题",
      "description": "本章要涵盖的内容描述（50-100字）",
      "sections": ["小节1标题", "小节2标题"],
      "targetWords": 2000
    }
  ]
}
\`\`\`

注意：
- 每章的 targetWords 应该合理分配，总字数约 ${targetPages * 500} 字
- 章节之间要有逻辑递进关系
- 包含引言/概述和总结章节
- 重要：只输出纯 JSON，不要添加任何说明文字、注释或 markdown 格式
- description 中不要使用双引号，用单引号或避免引号
- sections 数组中每个元素是简短的标题字符串`;
}

function parseOutline(text) {
  try {
    let jsonStr = "";

    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();

    if (!jsonStr) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end > start) {
        jsonStr = text.slice(start, end + 1);
      }
    }

    if (!jsonStr) jsonStr = text;

    jsonStr = jsonStr
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/[​-‍﻿]/g, "")
      .replace(/\t/g, " ");

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e1) {
      const fixed = jsonStr
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/：/g, ":")
        .replace(/，/g, ",");
      try {
        parsed = JSON.parse(fixed);
      } catch (e2) {
        console.error("[LongDoc] Outline parse error:", e2.message);
        console.error("[LongDoc] Raw outline text (first 500):", text.slice(0, 500));
        console.error("[LongDoc] Extracted JSON (first 500):", jsonStr.slice(0, 500));
        return { title: "文档", abstract: "", chapters: [] };
      }
    }

    const result = {
      title: String(parsed.title || "未命名文档"),
      abstract: String(parsed.abstract || ""),
      chapters: Array.isArray(parsed.chapters) ? parsed.chapters.map(ch => ({
        title: String(ch.title || ""),
        description: String(ch.description || ""),
        sections: Array.isArray(ch.sections) ? ch.sections : [],
        targetWords: Number(ch.targetWords) || 2000,
      })) : [],
    };
    console.log(`[LongDoc] Outline parsed: "${result.title}", ${result.chapters.length} chapters`);
    return result;
  } catch (e) {
    console.error("[LongDoc] Outline parse error:", e.message);
    return { title: "文档", abstract: "", chapters: [] };
  }
}

export async function executeGenerateLongDoc(args, res) {
  const topic = String(args?.topic || "").trim();
  const requirements = String(args?.requirements || "").trim();
  const targetPages = Math.max(5, Math.min(120, Number(args?.pages) || 30));

  // Create a background job so progress survives client disconnect
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId, status: "running", createdAt: Date.now(),
    progress: [], artifact: null, result: null, error: null,
  };
  longDocJobs.set(jobId, job);

  if (res) {
    try { res.write(`event: longdoc_job\ndata: ${JSON.stringify({ jobId })}\n\n`); res.flush?.(); } catch {}
  }

  const sendProgress = (data) => {
    job.progress.push(data);
    if (job.progress.length > 50) job.progress = job.progress.slice(-40);
    if (res) {
      try { res.write(`event: longdoc_progress\ndata: ${JSON.stringify(data)}\n\n`); res.flush?.(); } catch {}
    }
  };

  try {
    // Step 1: Generate outline (main key)
    sendProgress({ stage: "outline", message: "正在规划文档大纲..." });
    const outlinePrompt = buildOutlinePrompt(topic, requirements, targetPages, "markdown");
    const outlineResult = await callClaude(outlinePrompt, 4096, 3, false);
    const outline = parseOutline(outlineResult);

    if (!outline.chapters.length) {
      return { summary: "大纲生成失败", content: "无法生成有效的文档大纲。请尝试更具体的主题描述。" };
    }

    sendProgress({ stage: "outline_done", message: `大纲完成：${outline.title}（${outline.chapters.length} 章）`, outline });

    // Step 1.5: Quick research phase (if web search is available)
    if (braveApiKey) {
      sendProgress({ stage: "research", message: "正在搜索参考资料..." });
      try {
        const searchQueries = outline.chapters.slice(0, 6).map(ch => ch.title + " " + outline.title);
        const searchResults = await Promise.all(
          searchQueries.slice(0, 3).map(q => braveSearch(q).catch(() => []))
        );
        const allResults = searchResults.flat();
        const researchText = allResults
          .map((r, i) => `[${i+1}] ${r.title}: ${r.description}`)
          .join("\n")
          .slice(0, 4000);
        if (researchText) {
          for (const ch of outline.chapters) {
            ch.research = researchText;
          }
          sendProgress({ stage: "research_done", message: `搜索完成，获取 ${allResults.length} 条参考` });
        }
      } catch (e) {
        console.log("[LongDoc] Research phase error (non-fatal):", e.message);
      }
    }

    // Step 2: Generate chapters with sub-agent keys
    const allChapters = [];
    const batchSize = 2;
    for (let i = 0; i < outline.chapters.length; i += batchSize) {
      const batch = outline.chapters.slice(i, i + batchSize);
      sendProgress({
        stage: "writing",
        message: `正在撰写第 ${i + 1}-${Math.min(i + batchSize, outline.chapters.length)}/${outline.chapters.length} 章...`,
        current: i,
        total: outline.chapters.length,
      });

      const promises = batch.map((chapter, idx) => {
        const chapterIndex = i + idx;
        const prevSummary = allChapters.length > 0
          ? allChapters.slice(-3).map((c, ci) => `「${c.title}」摘要: ${c.content.slice(0, 300)}...`).join("\n")
          : "";
        return generateChapterWithSearch(chapter, chapterIndex, outline, prevSummary, targetPages)
          .then(result => {
            sendProgress({ stage: "chapter_done", index: chapterIndex, title: chapter.title });
            return result;
          })
          .catch(err => {
            console.error(`[LongDoc] Chapter ${chapterIndex} failed:`, err.message);
            sendProgress({ stage: "chapter_error", index: chapterIndex, title: chapter.title, error: err.message });
            return { title: chapter.title, content: `[第${chapterIndex + 1}章生成失败: ${err.message}]` };
          });
      });

      const results = await Promise.all(promises);
      allChapters.push(...results);
      if (i + batchSize < outline.chapters.length) await delay(1500);
    }

    // Step 3: Assemble
    sendProgress({ stage: "assembly", message: "正在组装最终文档..." });
    const finalDoc = assembleMarkdown(outline, allChapters);
    const estimatedPages = Math.round(finalDoc.length / 1500);

    sendProgress({ stage: "complete", message: `文档完成：${outline.chapters.length} 章，约 ${estimatedPages} 页` });

    const artifactData = {
      title: outline.title,
      type: "document",
      content: finalDoc,
      language: "markdown",
      description: `长文档 · ${outline.chapters.length}章 · ~${estimatedPages}页`,
      file_path: "document.md",
    };
    job.artifact = artifactData;
    job.status = "completed";
    job.result = {
      summary: `已生成「${outline.title}」(${outline.chapters.length}章, ~${estimatedPages}页)`,
      content: `Long document "${outline.title}" generated: ${outline.chapters.length} chapters, ~${estimatedPages} pages. The document is now visible in the preview panel.`,
    };

    if (res) {
      try {
        res.write(`event: artifact\ndata: ${JSON.stringify(artifactData)}\n\n`);
        res.flush?.();
      } catch {}
    }

    return job.result;
  } catch (err) {
    console.error("[LongDoc] Error:", err);
    job.status = "failed";
    job.error = err.message;
    return { summary: "生成失败", content: `Long document generation failed: ${err.message}` };
  }
}

async function generateChapterWithSearch(chapter, index, outline, prevSummary, totalPages) {
  // Simple approach: generate chapter text directly, no tool use
  // (sub-agent keys may not support tools on LuckyAPI)
  const prompt = `你是一位专业的文档撰写者。请撰写以下文档的第 ${index + 1} 章。

文档标题：${outline.title}
文档摘要：${outline.abstract}
本章标题：${chapter.title}
本章要求：${chapter.description}
本章小节：${chapter.sections.join("、")}
目标字数：约${chapter.targetWords}字

${prevSummary ? `前文摘要（确保内容连贯）：\n${prevSummary}\n` : ""}
${chapter.research ? `参考资料：\n${chapter.research}\n` : ""}

要求：
- 直接输出正文内容，不要输出"第X章"标题（我会自动添加）
- 包含所有小节，每个小节用 ## 标记
- 内容要专业、详实、有深度
- 适当使用表格、列表丰富内容
- 字数要达到目标（${chapter.targetWords}字左右）
- 使用 Markdown 格式`;

  const maxTokens = Math.min(16384, Math.max(4096, Math.round(chapter.targetWords * 2)));
  const result = await callClaude(prompt, maxTokens, 3, true);
  return { title: chapter.title, content: result };
}

function assembleMarkdown(outline, chapters) {
  const parts = [];
  parts.push(`# ${outline.title}\n`);
  if (outline.abstract) {
    parts.push(`> ${outline.abstract}\n`);
  }
  parts.push(`---\n`);
  parts.push(`## 目录\n`);
  chapters.forEach((ch, i) => {
    parts.push(`${i + 1}. ${ch.title}`);
  });
  parts.push(`\n---\n`);
  chapters.forEach((ch, i) => {
    parts.push(`## 第${i + 1}章 ${ch.title}\n`);
    parts.push(ch.content);
    parts.push(`\n`);
  });
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Export as DOCX (Markdown → docx Document)
// ---------------------------------------------------------------------------
export function markdownToDocx(title, markdown) {
  const lines = markdown.split("\n");
  const children = [];
  let inCodeBlock = false;
  let codeLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        children.push(new Paragraph({
          children: [new TextRun({ text: codeLines.join("\n"), font: "Courier New", size: 18 })],
          spacing: { before: 100, after: 100 },
          shading: { type: "clear", fill: "F5F5F5" },
        }));
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.startsWith("# ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      }));
      continue;
    }
    if (line.startsWith("## ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(3)),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 150 },
      }));
      continue;
    }
    if (line.startsWith("### ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(4)),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      children.push(new Paragraph({
        children: [],
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" } },
        spacing: { before: 200, after: 200 },
      }));
      continue;
    }

    if (line.startsWith("> ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 3, color: "C05A32" } },
        spacing: { before: 100, after: 100 },
      }));
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.replace(/^[-*]\s+/, "")),
        bullet: { level: 0 },
        spacing: { before: 40, after: 40 },
      }));
      continue;
    }

    const olMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (olMatch) {
      children.push(new Paragraph({
        children: parseInlineFormatting(olMatch[2]),
        numbering: { reference: "default-numbering", level: 0 },
        spacing: { before: 40, after: 40 },
      }));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      i--;
      const tableRows = tableLines.filter((_, idx) => idx !== 1); // skip separator
      if (tableRows.length) {
        const rows = tableRows.map((row, rowIdx) => {
          const cells = row.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
          return new TableRow({
            children: cells.map(cell => new TableCell({
              children: [new Paragraph({
                children: [new TextRun({ text: cell, bold: rowIdx === 0, size: 20 })],
              })],
              width: { size: Math.floor(100 / cells.length), type: WidthType.PERCENTAGE },
            })),
          });
        });
        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      }
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    children.push(new Paragraph({
      children: parseInlineFormatting(line),
      spacing: { before: 60, after: 60 },
    }));
  }

  return new Document({
    numbering: {
      config: [{
        reference: "default-numbering",
        levels: [{
          level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
    }],
  });
}

function parseInlineFormatting(text) {
  const runs = [];
  const parts = String(text || "").split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 22 }));
    } else if (part.startsWith("`") && part.endsWith("`")) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: "Courier New", size: 20, shading: { type: "clear", fill: "F0F0F0" } }));
    } else {
      runs.push(new TextRun({ text: part, size: 22 }));
    }
  }
  return runs;
}

export function safeDocFilename(name) {
  return String(name || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
}
