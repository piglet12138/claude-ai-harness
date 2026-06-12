// Web search + page fetch — extracted from server.mjs (strangler refactor).
// 9-engine fallback search chain + robust multi-source fetch with query-aware ingestion.
import { stripTags, extractTextFromHtml } from "../lib/util.mjs";
import { extractRelevant } from "../lib/llm.mjs";
import {
  serperApiKey, tavilyApiKey, googleCseApiKey, googleCseCx,
  exaApiKey, firecrawlApiKey, serpApiKey, searchApiKey, braveApiKey,
} from "../lib/config.mjs";

export async function serperSearch(query) {
  if (!serperApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const hasChinese = /[一-鿿]/.test(query);
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": serperApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: 10,
        ...(hasChinese ? { gl: "cn", hl: "zh-cn" } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[Serper] Error ${resp.status}: ${errText.slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const organic = (data.organic || []).slice(0, 8).map(item => ({
      title: item.title || "",
      url: item.link || "",
      description: (item.snippet || "").slice(0, 800),
      age: item.date || "",
    }));
    const kg = data.knowledgeGraph;
    if (kg?.description) {
      organic.unshift({
        title: kg.title || query,
        url: kg.website || "",
        description: `${kg.description} ${kg.attributes ? Object.entries(kg.attributes).map(([k,v]) => `${k}: ${v}`).join("; ") : ""}`.slice(0, 800),
        age: "",
      });
    }
    console.log(`[Serper] ${organic.length} results for: ${query.slice(0, 40)}`);
    return organic;
  } catch (e) {
    console.log(`[Serper] Failed: ${e.message}`);
    return [];
  }
}

// Tavily — AI-optimized search, good summaries
export async function tavilySearch(query) {
  if (!tavilyApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: query,
        search_depth: "basic",
        max_results: 8,
        include_answer: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[Tavily] Error ${resp.status}: ${errText.slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.results || []).map(item => ({
      title: item.title || "",
      url: item.url || "",
      description: (item.content || "").slice(0, 800),
      age: "",
    }));
    if (data.answer) {
      results.unshift({
        title: "AI 摘要",
        url: "",
        description: data.answer.slice(0, 1000),
        age: "",
      });
    }
    console.log(`[Tavily] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[Tavily] Failed: ${e.message}`);
    return [];
  }
}

// Google Custom Search Engine
export async function googleCseSearch(query) {
  if (!googleCseApiKey || !googleCseCx) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const hasChinese = /[一-鿿]/.test(query);
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", googleCseApiKey);
    url.searchParams.set("cx", googleCseCx);
    url.searchParams.set("q", query);
    url.searchParams.set("num", "8");
    if (hasChinese) {
      url.searchParams.set("lr", "lang_zh-CN|lang_zh-TW");
    }
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[GoogleCSE] Error ${resp.status}: ${errText.slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.items || []).map(item => ({
      title: item.title || "",
      url: item.link || "",
      description: (item.snippet || "").replace(/\n/g, " ").slice(0, 800),
      age: "",
    }));
    console.log(`[GoogleCSE] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[GoogleCSE] Failed: ${e.message}`);
    return [];
  }
}

// Exa — neural search, returns query-relevant highlights (already ingestion-filtered)
export async function exaSearch(query) {
  if (!exaApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": exaApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 8,
        contents: { highlights: true },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[Exa] Error ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.results || []).map((item) => ({
      title: item.title || "",
      url: item.url || "",
      description: (Array.isArray(item.highlights) ? item.highlights.join(" … ") : (item.text || "")).slice(0, 800),
      age: item.publishedDate ? String(item.publishedDate).slice(0, 10) : "",
    }));
    console.log(`[Exa] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[Exa] Failed: ${e.message}`);
    return [];
  }
}

// Firecrawl — search with built-in scrape (handles JS / anti-bot)
export async function firecrawlSearch(query) {
  if (!firecrawlApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${firecrawlApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 8 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[Firecrawl] Error ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.data || []).map((item) => ({
      title: item.title || "",
      url: item.url || "",
      description: (item.description || item.markdown || "").slice(0, 800),
      age: "",
    }));
    console.log(`[Firecrawl] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[Firecrawl] Failed: ${e.message}`);
    return [];
  }
}

// SerpAPI — Google SERP (100/mo free)
export async function serpApiSearch(query) {
  if (!serpApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const hasChinese = /[一-鿿]/.test(query);
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    url.searchParams.set("num", "10");
    url.searchParams.set("api_key", serpApiKey);
    if (hasChinese) { url.searchParams.set("gl", "cn"); url.searchParams.set("hl", "zh-cn"); }
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[SerpAPI] Error ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.organic_results || []).slice(0, 8).map((item) => ({
      title: item.title || "",
      url: item.link || "",
      description: (item.snippet || "").slice(0, 800),
      age: item.date || "",
    }));
    console.log(`[SerpAPI] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[SerpAPI] Failed: ${e.message}`);
    return [];
  }
}

// searchapi.io — Google SERP (100/mo free)
export async function searchApiSearch(query) {
  if (!searchApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const hasChinese = /[一-鿿]/.test(query);
    const url = new URL("https://www.searchapi.io/api/v1/search");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    if (hasChinese) { url.searchParams.set("gl", "cn"); url.searchParams.set("hl", "zh-cn"); }
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${searchApiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[SearchApi] Error ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.organic_results || []).slice(0, 8).map((item) => ({
      title: item.title || "",
      url: item.link || "",
      description: (item.snippet || "").slice(0, 800),
      age: item.date || "",
    }));
    console.log(`[SearchApi] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[SearchApi] Failed: ${e.message}`);
    return [];
  }
}

// Smart multi-engine search with fallback chain
export async function multiSearch(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return [];

  // Fallback chain: Brave primary (user's monthly free quota), then free-quota-first.
  // Each tier only fires if we still have < 3 results, so quota burn stays minimal.
  const chain = [
    ["Brave", braveApiKey, braveSearch],        // primary — user choice, monthly free
    ["SerpAPI", serpApiKey, serpApiSearch],     // 100/mo free, Google SERP
    ["SearchApi", searchApiKey, searchApiSearch], // 100/mo free, Google SERP
    ["Exa", exaApiKey, exaSearch],              // neural + query-relevant highlights
    ["Serper", serperApiKey, serperSearch],     // one-time free credits
    ["Tavily", tavilyApiKey, tavilySearch],     // credits
    ["GoogleCSE", googleCseApiKey && googleCseCx, googleCseSearch],
    ["Firecrawl", firecrawlApiKey, firecrawlSearch], // credits — keep low (search+scrape)
    ["DDG", true, duckDuckGoSearch],            // keyless, last resort
  ];

  let results = [];
  const usedEngines = [];
  for (const [name, gate, fn] of chain) {
    if (results.length >= 3) break;
    if (!gate) continue;
    const r = await fn(q).catch(() => []);
    if (r.length) {
      usedEngines.push(name);
      results = mergeResults(results, r);
    }
  }

  console.log(`[Search] "${q.slice(0, 30)}" → ${results.length} results via [${usedEngines.join(" → ")}]`);
  return results.slice(0, 10);
}

// Merge results, deduplicate by URL
export function mergeResults(existing, incoming) {
  const urls = new Set(existing.map(r => r.url).filter(Boolean));
  const merged = [...existing];
  for (const r of incoming) {
    if (!r.url || urls.has(r.url)) continue;
    urls.add(r.url);
    merged.push(r);
  }
  return merged;
}

// Fetch page text (lightweight, for auto-fetch after search)
// Plain fetch + regex extract (free, fast). Returns "" on failure / non-text / JS-thin pages.
export async function plainFetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!resp.ok) return "";
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("text")) return "";
    return extractTextFromHtml(await resp.text());
  } catch {
    clearTimeout(timeout);
    return "";
  }
}

// Jina Reader — free, no key, renders JS, returns clean markdown
export async function jinaFetchText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch("https://r.jina.ai/" + url, {
      headers: { "x-respond-with": "markdown", "accept": "text/plain" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return "";
    return (await resp.text()).trim();
  } catch { return ""; }
}

// Firecrawl scrape — handles JS + anti-bot, returns markdown (credits)
export async function firecrawlScrape(url) {
  if (!firecrawlApiKey) return "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${firecrawlApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return "";
    const data = await resp.json();
    return String(data?.data?.markdown || "").trim();
  } catch { return ""; }
}

// Exa /contents — clean parsed text for a known URL (credits)
export async function exaContents(url) {
  if (!exaApiKey) return "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "x-api-key": exaApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: 24000 } }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return "";
    const data = await resp.json();
    return String(data?.results?.[0]?.text || "").trim();
  } catch { return ""; }
}

// Robust fetch: plain → Jina (JS) → Firecrawl (anti-bot) → Exa contents. Stops at first solid hit.
export async function robustFetchText(url) {
  const THIN = 200; // below this, treat as JS-rendered / blocked and escalate
  let text = await plainFetchText(url);
  if (text.length >= THIN) return text;
  const jina = await jinaFetchText(url);
  if (jina.length >= THIN) return jina;
  const fc = await firecrawlScrape(url);
  if (fc.length >= THIN) return fc;
  const exa = await exaContents(url);
  if (exa.length >= THIN) return exa;
  return text || jina || fc || exa || "";
}

// Fetch a page and (optionally) keep only query-relevant content at ingestion time.
export async function exaContentsRelevant(url, query) {
  if (!exaApiKey || !query) return "";
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
    const r = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "x-api-key": exaApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [url], highlights: { query, numSentences: 5, highlightsPerUrl: 5 } }),
      signal: c.signal,
    });
    clearTimeout(t); if (!r.ok) return "";
    const d = await r.json();
    return (Array.isArray(d?.results?.[0]?.highlights) ? d.results[0].highlights.join("\n… ") : "").trim();
  } catch { return ""; }
}

export async function fetchPageText(url, maxLen = 6000, query = "") {
  // Preferred: Exa /contents query-relevant excerpt (provider-side relevance, no Haiku round-trip)
  if (query) {
    const exa = await exaContentsRelevant(url, query);
    if (exa.length >= 200) return exa.slice(0, maxLen);
  }
  // Fallback: robust raw fetch + local Haiku query-extraction
  const text = await robustFetchText(url);
  if (!text) return "";
  return await extractRelevant(text, query, maxLen);
}

// DuckDuckGo HTML search (no API key needed, better Chinese coverage than Brave)
export async function duckDuckGoSearch(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const html = await resp.text();

    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, 8); i++) {
      const rawUrl = links[i][1];
      let actualUrl = rawUrl;
      try {
        const decoded = decodeURIComponent(rawUrl);
        const uddgMatch = decoded.match(/uddg=([^&]+)/);
        if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
      } catch {}
      if (!actualUrl.startsWith("http")) continue;
      if (actualUrl.includes("duckduckgo.com/y.js")) continue; // skip ads
      results.push({
        title: stripTags(links[i][2]).trim(),
        url: actualUrl,
        description: snippets[i] ? stripTags(snippets[i][1]).trim().slice(0, 600) : "",
        age: "",
      });
    }
    return results;
  } catch {
    return [];
  }
}

export async function braveSearch(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return [];
  const hasChinese = /[一-鿿]/.test(q);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", "12");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("result_filter", "web,news");
  if (hasChinese) {
    url.searchParams.set("search_lang", "zh");
    // Note: do NOT set country=cn, it breaks Brave results for Chinese queries
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "accept-language": hasChinese ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9",
      "x-subscription-token": braveApiKey,
    },
  });
  if (!response.ok) return [];
  const data = await response.json();

  const webResults = (data.web?.results || []).slice(0, 8).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(
      [item.description || "", ...(item.extra_snippets || [])].join(" ").trim()
    ).slice(0, 800),
    age: item.age || "",
  }));

  const newsResults = (data.news?.results || []).slice(0, 4).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(item.description || "").slice(0, 800),
    age: item.age || "",
  }));

  const seen = new Set();
  const merged = [];
  for (const r of [...newsResults, ...webResults]) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    merged.push(r);
  }
  return merged.slice(0, 8);
}
