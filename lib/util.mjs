// Stateless cross-cutting helpers — extracted from server.mjs (strangler refactor).
// No internal deps; safe for any module to import.

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export function chunkText(text) {
  const value = String(text || "");
  if (!value) return [];
  return value.match(/[\s\S]{1,14}/g) || [value];
}

export function safeParseJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function extractTextFromHtml(html) {
  // Simple HTML to text extraction - strip tags, scripts, styles
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
