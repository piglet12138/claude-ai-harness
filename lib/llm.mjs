// LLM call helpers — extracted from server.mjs (strangler refactor).
// Non-streaming Haiku/Claude calls + ingestion filters. The main streaming chat
// loop stays in server.mjs (consumeAnthropicStream).
import crypto from "node:crypto";
import { dbToolResultSummary } from "../db.mjs";
import { delay } from "./util.mjs";
import {
  llmProvider, apiEndpoint, pickKey, HAIKU_MODEL, markKeyFailed, markKeyOk, model, extractMode,
} from "./config.mjs";

// 视觉调用：content 是 message content 块数组（text + image），用主模型（vision），返回纯文本。
// 用于 make_pptx 的内部渲染-视觉 QA——图片只活在这次临时调用里，不进主对话上下文。
export async function callClaudeVision(contentBlocks, maxTokens = 1500, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const key = pickKey();
    try {
      if (attempt > 1) await delay(2000 * attempt);
      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2024-10-22" },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: contentBlocks }] }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        markKeyFailed(key, response.status);
        if (attempt < retries && (response.status === 403 || response.status === 429 || response.status >= 500)) continue;
        throw new Error(`Vision API ${response.status}: ${errText.slice(0, 200)}`);
      }
      markKeyOk(key);
      const data = await response.json();
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    } catch (err) {
      if (attempt < retries && !err.message?.startsWith("Vision API")) continue;
      throw err;
    }
  }
}

export async function callHaiku(prompt, maxTokens = 512) {
  const P = llmProvider();
  const endpoint = P.isDeepSeek ? P.endpoint : apiEndpoint;
  const key = P.isDeepSeek ? P.apiKey : pickKey();
  const haikuModel = P.isDeepSeek ? P.haikuModel : HAIKU_MODEL;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2024-10-22",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model: haikuModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Haiku API ${response.status}: ${err.slice(0, 100)}`);
  }
  const data = await response.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return { text, inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 };
}

// Summarize a tool_result with Haiku, caching by content hash to avoid redundant calls
export async function summarizeWithHaiku(content, haikuStats) {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const cached = dbToolResultSummary.get(hash);
  if (cached) return cached;

  const prompt = `以下是一段工具调用结果，请用1-2句中文简洁总结其核心信息，保留关键数据和结论：\n\n${content.slice(0, 8000)}`;
  const { text, inputTokens, outputTokens } = await callHaiku(prompt);

  dbToolResultSummary.set(hash, text);
  haikuStats.calls++;
  haikuStats.inputTokens += inputTokens;
  haikuStats.outputTokens += outputTokens;

  return text;
}

// Query-aware ingestion filter (claude.ai-style): read full page text, keep ONLY what's
// relevant to `query`, drop the rest. Replaces blind char-truncation so the answer isn't
// silently sliced off past char N. Falls back to truncation when disabled / no query / short.
export async function extractRelevant(fullText, query, maxLen = 6000) {
  const text = String(fullText || "");
  if (extractMode !== "relevance" || !query || text.length <= 1200) {
    return text.slice(0, maxLen);
  }
  const hash = crypto.createHash("sha256").update("extract:" + query + "\n" + text).digest("hex");
  const cached = dbToolResultSummary.get(hash);
  if (cached) return cached;
  try {
    const prompt = `你是一个网页信息提取器。下面是一篇网页的正文。请只提取与【问题】相关的事实、数据、原句、结论，原样保留关键细节（数字、日期、名称、引用），删除导航/广告/无关段落。不要复述问题，不要加评论，直接输出提取内容（中文或原文均可）。若整页都与问题无关，输出"（无相关内容）"。\n\n【问题】${query}\n\n【正文】\n${text.slice(0, 24000)}`;
    const { text: out } = await callHaiku(prompt, 1024);
    const result = (out || "").trim().slice(0, maxLen) || text.slice(0, maxLen);
    dbToolResultSummary.set(hash, result);
    return result;
  } catch (e) {
    console.log(`[Extract] Haiku extract failed, truncating: ${e.message}`);
    return text.slice(0, maxLen);
  }
}

// Non-streaming Claude call with key-pool retry (used by long-document generation)
export async function callClaude(prompt, maxTokens = 8192, retries = 3, useSubKey = false) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const key = pickKey(useSubKey);
    const masked = key.slice(0, 6) + "..." + key.slice(-4);
    try {
      if (attempt > 1) await delay(2000 * attempt);
      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2024-10-22",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        markKeyFailed(key, response.status);
        if (attempt < retries && (response.status === 403 || response.status === 429 || response.status >= 500)) {
          console.log(`[LongDoc] Key ${masked} failed (${response.status}), switching key and retrying ${attempt}/${retries}...`);
          continue;
        }
        throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
      }
      markKeyOk(key);
      const data = await response.json();
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    } catch (err) {
      if (attempt < retries && !err.message?.startsWith("Claude API")) {
        console.log(`[LongDoc] Key ${masked} network error, retry ${attempt}/${retries}:`, err.message);
        continue;
      }
      throw err;
    }
  }
}
