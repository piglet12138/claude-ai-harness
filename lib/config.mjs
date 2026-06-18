// Configuration + API key pool + LLM provider routing.
// Extracted from server.mjs (strangler refactor). This is the shared foundation
// every feature module imports; it must not import any sibling module back.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEnv(file) {
  const result = {};
  try {
    const text = await fs.readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      result[line.slice(0, index)] = line.slice(index + 1);
    }
  } catch {
    // Optional.
  }
  return result;
}

export const env = await loadEnv(path.join(projectRoot, ".env"));
export const port = Number(env.PORT || process.env.PORT || 3040);
export const baseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
export const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
export const model = process.env.MODEL || env.MODEL || "claude-opus-4-7";

// 流畅模式（DeepSeek）—— 复用整套 harness，只把 LLM 打到 DeepSeek 的 anthropic 兼容端点。
export const deepseekApiKey = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;
export const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const deepseekModel = process.env.DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || "deepseek-v4-pro";
export const deepseekHaikuModel = process.env.DEEPSEEK_HAIKU_MODEL || env.DEEPSEEK_HAIKU_MODEL || "deepseek-v4-flash";

// 每请求 LLM provider（AsyncLocalStorage 透传）。默认 = Anthropic（luckyapi）；流畅模式 = DeepSeek。
export const reqCtx = new AsyncLocalStorage();
export function llmProvider() {
  const p = reqCtx.getStore()?.provider;
  if (p) return p; // DeepSeek
  return { isDeepSeek: false, endpoint: apiEndpoint, mainModel: model, haikuModel: HAIKU_MODEL };
}
export function deepseekProvider() {
  return {
    isDeepSeek: true,
    endpoint: `${deepseekBaseUrl.replace(/\/+$/, "")}/anthropic/v1/messages`,
    apiKey: deepseekApiKey,
    mainModel: deepseekModel,
    haikuModel: deepseekHaikuModel,
  };
}

export const accessEmail = process.env.ACCESS_EMAIL || env.ACCESS_EMAIL;
export const accessPassword = process.env.ACCESS_PASSWORD || env.ACCESS_PASSWORD;
export const sessionSecret = process.env.SESSION_SECRET || env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
export const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || env.BRAVE_SEARCH_API_KEY;
export const serperApiKey = process.env.SERPER_API_KEY || env.SERPER_API_KEY || "";
export const tavilyApiKey = process.env.TAVILY_API_KEY || env.TAVILY_API_KEY || "";
export const googleCseApiKey = process.env.GOOGLE_CSE_API_KEY || env.GOOGLE_CSE_API_KEY || "";
export const googleCseCx = process.env.GOOGLE_CSE_CX || env.GOOGLE_CSE_CX || "";
export const exaApiKey = process.env.EXA_API_KEY || env.EXA_API_KEY || "";
export const firecrawlApiKey = process.env.FIRECRAWL_API_KEY || env.FIRECRAWL_API_KEY || "";
export const serpApiKey = process.env.SERPAPI_API_KEY || env.SERPAPI_API_KEY || "";
export const searchApiKey = process.env.SEARCHAPI_API_KEY || env.SEARCHAPI_API_KEY || "";
// Ingestion filter: "relevance" = query-aware Haiku extraction, "truncate" = legacy char-slice
export const extractMode = (process.env.EXTRACT_MODE || env.EXTRACT_MODE || "relevance").toLowerCase();
// claude.ai-style selective retrieval: auto-fetch top-N per search
export const autoFetchN = Math.max(0, Number(process.env.AUTO_FETCH_COUNT || env.AUTO_FETCH_COUNT || 1));
// Skip auto-fetch when inline snippets are already rich
export const inlineRichChars = Math.max(0, Number(process.env.INLINE_RICH_CHARS || env.INLINE_RICH_CHARS || 2600));
export const webSearchEnabled = /^(true|1|yes)$/i.test(process.env.ENABLE_WEB_SEARCH || env.ENABLE_WEB_SEARCH || "false");
export const webSearchCount = Math.max(1, Math.min(5, Number(process.env.WEB_SEARCH_RESULT_COUNT || env.WEB_SEARCH_RESULT_COUNT || 3)));
export const webSearchQueryCount = Math.max(1, Math.min(3, Number(process.env.WEB_SEARCH_QUERY_COUNT || env.WEB_SEARCH_QUERY_COUNT || 2)));
export const googleClientId = process.env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
export const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
export const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI;
export const googleTokenFile = path.resolve(projectRoot, process.env.GOOGLE_TOKEN_FILE || env.GOOGLE_TOKEN_FILE || ".google-token.json");
export const googleScopes = ["https://www.googleapis.com/auth/drive.file"];
export const googleOauthStates = new Map();

// AI 生图（luckyapi，OpenAI 兼容 /v1/images/generations）。生图 45-80s，必须在 run_code 之外做。
export const imageGenKey = process.env.IMAGE_GEN_KEY || env.IMAGE_GEN_KEY || "";
export const imageGenBaseUrl = (process.env.IMAGE_GEN_BASE_URL || env.IMAGE_GEN_BASE_URL || "https://luckyapi.chat").replace(/\/+$/, "");
export const imageGenModel = process.env.IMAGE_GEN_MODEL || env.IMAGE_GEN_MODEL || "(按次)gpt-image-2";

// Email notifications via Resend (for bug reports)
export const resendApiKey = process.env.RESEND_API_KEY || env.RESEND_API_KEY || "";
export const notifyEmails = (process.env.NOTIFY_EMAILS || env.NOTIFY_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean);

export const apiEndpoint = `${baseUrl.replace(/\/v1\/?$/, "")}/v1/messages`;
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const PROACTIVE_TOKEN_BUDGET = 30000; // trigger Haiku summarization early
export const HARD_CAP = 100000;              // hard truncation fallback after compression
export const IN_LOOP_TOKEN_BUDGET = 80000;   // looser budget for mid-loop compress

// ---------------------------------------------------------------------------
// API Key Pool — round-robin with temporary cooldown on failure
// ANTHROPIC_API_KEY is primary, SUB_AGENT_KEYS is comma-separated extras.
// ---------------------------------------------------------------------------
const allApiKeys = [
  apiKey,
  ...(process.env.SUB_AGENT_KEYS || env.SUB_AGENT_KEYS || "")
    .split(",").map(k => k.trim()).filter(Boolean),
].filter(Boolean);
const keyCooldowns = new Map(); // key -> cooldownUntil timestamp
const COOLDOWN_MS = 3 * 60_000; // 3 minutes cooldown after failure
let keyIndex = 0;

export function pickKey(preferSub = false) {
  const now = Date.now();
  const startOffset = (preferSub && allApiKeys.length > 1) ? 1 : 0;
  for (let i = 0; i < allApiKeys.length; i++) {
    const idx = (keyIndex + startOffset + i) % allApiKeys.length;
    const key = allApiKeys[idx];
    const coolUntil = keyCooldowns.get(key) || 0;
    if (now >= coolUntil) {
      keyIndex = idx + 1; // advance for next call
      return key;
    }
  }
  // All keys on cooldown — use the one that cools down soonest
  let bestKey = allApiKeys[0], bestTime = Infinity;
  for (const key of allApiKeys) {
    const t = keyCooldowns.get(key) || 0;
    if (t < bestTime) { bestTime = t; bestKey = key; }
  }
  console.log(`[KeyPool] All keys on cooldown, using least-cooled key (wait ${Math.round((bestTime - now) / 1000)}s)`);
  return bestKey;
}

export function markKeyFailed(key, statusCode) {
  const cooldown = statusCode === 429 ? COOLDOWN_MS : COOLDOWN_MS * 2; // rate limit: 3min, balance/other: 6min
  keyCooldowns.set(key, Date.now() + cooldown);
  const masked = key.slice(0, 6) + "..." + key.slice(-4);
  console.log(`[KeyPool] Key ${masked} cooled down for ${cooldown / 1000}s (HTTP ${statusCode}), ${allApiKeys.length - [...keyCooldowns.values()].filter(t => t > Date.now()).length}/${allApiKeys.length} keys available`);
}

export function markKeyOk(key) {
  keyCooldowns.delete(key); // clear cooldown on success
}

console.log(`[KeyPool] Loaded ${allApiKeys.length} API key(s)`);

if (!apiKey) {
  throw new Error("ANTHROPIC_API_KEY is required. Set it in .env or as an environment variable.");
}
if (!accessEmail || !accessPassword) {
  throw new Error("ACCESS_EMAIL and ACCESS_PASSWORD are required. Set them in .env or as environment variables.");
}
