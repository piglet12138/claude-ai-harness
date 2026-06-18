// AI 生图工具 —— 调 luckyapi 的 OpenAI 兼容 images 端点生成插图/概念图。
// 设计：生图 45-80s，远超 run_code 沙箱的 30s 超时，所以必须作为独立工具在 run_code 之外做。
// 产物落到 FILES_DIR（绝对路径、跨请求持久），返回路径给模型，模型再在 run_code 里 addImage({path}) 嵌进 PPT；
// 同时返回 dataUrl 走 SSE 给前端内联展示（不进模型上下文，避免 base64 撑爆 token）。
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { FILES_DIR } from "../lib/state.mjs";
import { imageGenKey, imageGenBaseUrl, imageGenModel } from "../lib/config.mjs";

const VALID_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const GEN_TIMEOUT_MS = 150000;
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function generateImage(prompt, size = "1536x1024") {
  if (!imageGenKey) return { error: true, message: "图像生成未配置（缺少 IMAGE_GEN_KEY）" };
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) return { error: true, message: "空 prompt" };
  if (!VALID_SIZES.has(size)) size = "1536x1024";

  const url = `${imageGenBaseUrl}/v1/images/generations`;
  const body = JSON.stringify({ model: imageGenModel, prompt: cleanPrompt, size, n: 1 });

  // 生图供应商易抖（"excessive system load" 400 / 429 / 5xx / CDN 524 超时），重试到 3 次。
  let data, lastErr = "未知错误";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${imageGenKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
      });
      if (resp.ok) { data = await resp.json(); break; }
      const t = await resp.text().catch(() => "");
      lastErr = `HTTP ${resp.status}: ${t.slice(0, 200)}`;
    } catch (e) {
      lastErr = e.name === "TimeoutError" ? "请求超时" : e.message;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(3000 * attempt);
  }
  if (!data) return { error: true, message: `生图失败（重试 ${MAX_ATTEMPTS} 次）：${lastErr}` };

  const item = data?.data?.[0] || {};
  let buf;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    let dlErr = "未知错误";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const ir = await fetch(item.url, { signal: AbortSignal.timeout(GEN_TIMEOUT_MS) });
        if (ir.ok) { buf = Buffer.from(await ir.arrayBuffer()); break; }
        dlErr = `HTTP ${ir.status}`;
      } catch (e) { dlErr = e.name === "TimeoutError" ? "下载超时" : e.message; }
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
    if (!buf) return { error: true, message: `生图结果下载失败：${dlErr}` };
  } else {
    return { error: true, message: "生图返回为空（无 url / b64_json）" };
  }
  if (!buf || buf.length < 1024) return { error: true, message: "生图结果异常（数据过小）" };

  const fileId = crypto.randomUUID();
  const destPath = path.join(FILES_DIR, `${fileId}.png`);
  await fs.writeFile(destPath, buf);

  return {
    ok: true,
    path: destPath,
    size,
    bytes: buf.length,
    dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
  };
}
