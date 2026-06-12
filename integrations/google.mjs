// Google Drive / Docs OAuth + upload — extracted from server.mjs (strangler refactor).
// HTTP handlers (status / auth start / callback / upload) + token persistence helpers.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { json, html } from "../lib/http.mjs";
import { escapeHtml } from "../lib/util.mjs";
import {
  googleClientId, googleClientSecret, googleRedirectUri, googleTokenFile,
  googleScopes, googleOauthStates, port,
} from "../lib/config.mjs";

export function googleConfigured() {
  return Boolean(googleClientId && googleClientSecret);
}

function getGoogleRedirectUri(req) {
  if (googleRedirectUri) return googleRedirectUri;
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${port}`;
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("127.0.0.1") || String(host).startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/google/callback`;
}

function cleanupGoogleStates() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [state, data] of googleOauthStates) {
    if (!data || data.createdAt < cutoff) googleOauthStates.delete(state);
  }
}

async function readGoogleToken() {
  try {
    return JSON.parse(await fs.readFile(googleTokenFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeGoogleToken(token) {
  await fs.writeFile(googleTokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function getGoogleAccessToken() {
  const token = await readGoogleToken();
  if (!token?.access_token) return "";
  if (Number(token.expiry_date || 0) > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) return "";
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const refreshed = await response.json().catch(() => ({}));
  if (!response.ok || !refreshed.access_token) return "";
  const next = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    expiry_date: Date.now() + Math.max(30, Number(refreshed.expires_in || 3600) - 60) * 1000,
  };
  await writeGoogleToken(next);
  return next.access_token;
}

function ensureUploadHtml(value, title) {
  const input = String(value || "");
  if (/<html[\s>]/i.test(input)) return input;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${input}</body></html>`;
}

function googleCallbackPage(title, detail, mode = "popup") {
  const script =
    mode === "redirect"
      ? "setTimeout(()=>location.replace('/app?google=connected'),700)"
      : "try{window.opener&&window.opener.postMessage({type:'google-auth-complete'},'*');setTimeout(()=>window.close(),900)}catch{}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#f7f3ec;color:#2d251d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.box{max-width:420px;border:1px solid #ddd2c3;border-radius:14px;background:#fffaf2;padding:26px;box-shadow:0 12px 34px rgba(45,37,29,.1)}h1{margin:0 0 10px;font-size:22px}p{margin:0;color:#766b5f;line-height:1.6}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${detail}</p></main><script>${script}</script></body></html>`;
}

function safeDriveName(name) {
  return String(name || "Untitled document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}

export async function googleStatus(res) {
  return json(res, {
    configured: googleConfigured(),
    connected: googleConfigured() && Boolean(await readGoogleToken()),
  });
}

export function startGoogleAuth(req, res) {
  if (!googleConfigured()) return html(res, googleCallbackPage("Google OAuth 未配置", "请先在 .env 中配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。"), 500);
  const url = new URL(req.url || "/", "http://localhost");
  const redirectUri = getGoogleRedirectUri(req);
  const state = crypto.randomBytes(24).toString("base64url");
  googleOauthStates.set(state, {
    createdAt: Date.now(),
    redirectUri,
    mode: url.searchParams.get("mode") === "redirect" ? "redirect" : "popup",
  });
  cleanupGoogleStates();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", googleScopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  res.writeHead(302, { location: authUrl.toString(), "cache-control": "no-store" });
  res.end();
}

export async function googleCallback(req, res, url) {
  if (!googleConfigured()) return html(res, googleCallbackPage("Google OAuth 未配置", "请先配置 Google OAuth 客户端。"), 500);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error") || "";
  const stateData = googleOauthStates.get(state);
  googleOauthStates.delete(state);
  if (error) return html(res, googleCallbackPage("Google 授权失败", escapeHtml(error)), 400);
  if (!code || !stateData || Date.now() - stateData.createdAt > 10 * 60_000) {
    return html(res, googleCallbackPage("Google 授权已失效", "请回到页面重新点击上传。"), 400);
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: stateData.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) {
    return html(res, googleCallbackPage("Google 授权失败", escapeHtml(token.error_description || token.error || "Token exchange failed")), 502);
  }
  const existing = await readGoogleToken();
  await writeGoogleToken({
    ...existing,
    ...token,
    refresh_token: token.refresh_token || existing?.refresh_token,
    expiry_date: Date.now() + Math.max(30, Number(token.expires_in || 3600) - 60) * 1000,
  });
  return html(
    res,
    googleCallbackPage(
      "Google Docs 已连接",
      stateData.mode === "redirect" ? "正在返回并继续上传文档。" : "你可以关闭这个窗口并回到文档上传。",
      stateData.mode,
    ),
  );
}

export async function uploadGoogleDoc(res, body) {
  if (!googleConfigured()) return json(res, { error: "Google OAuth is not configured" }, 428);
  const title = safeDriveName(body?.title || "Untitled document");
  const htmlContent = String(body?.html || "").slice(0, 8_000_000);
  if (!htmlContent.trim()) return json(res, { error: "Document is empty" }, 400);
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return json(res, { error: "Google account is not connected" }, 428);

  const boundary = `lite_claude_${crypto.randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: title,
    mimeType: "application/vnd.google-apps.document",
  });
  const bodyBuffer = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\ncontent-type: text/html; charset=utf-8\r\n\r\n`),
    Buffer.from(ensureUploadHtml(htmlContent, title), "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const upload = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": `multipart/related; boundary=${boundary}`,
      "content-length": String(bodyBuffer.length),
    },
    body: bodyBuffer,
  });
  const data = await upload.json().catch(async () => ({ error: await upload.text().catch(() => "") }));
  if (!upload.ok) return json(res, { error: `Google Drive upload failed ${upload.status}`, detail: data }, 502);
  return json(res, { ok: true, file: data });
}
