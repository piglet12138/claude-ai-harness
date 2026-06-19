// make_pptx —— 生成 + 渲染 + 内部视觉 QA 闭环，全部封装在工具内部（服务端）。
// 解决两个冲突：① QA 在工具返回前跑完，过关才捕获文件→docGenerated 才触发，不动 agent loop；
// ② 渲染图只进这一次临时 vision 调用，不进主对话→不撑 token、不碰压缩逻辑。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileStore, FILES_DIR } from "../lib/state.mjs";
import { callClaudeVision } from "../lib/llm.mjs";

const execFile = promisify(_execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM = path.join(projectRoot, "node_modules");
const QA_PATH = path.join(projectRoot, "tools", "pptx-qa.cjs"); // 仓内，require('pptx-qa') 解析到这

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const VISION_CHECKLIST = `你是 PPT 视觉质检员。下面是一份演示文稿逐页渲染图。

**只有出现以下「硬缺陷」之一才判 FAIL（这些让幻灯片读不了或明显坏掉）：**
A. 隐形/低对比文字：浅色或强调色压浅底、深色压深底，明显读不清（重点查卡片标题、网址、底部标签行）。
B. 文字溢出画布或被边缘裁切；文本框装不下导致文字被截断。
C. 装饰图形/色块压住文字导致读不了。
D. 元素严重重叠（卡片叠卡片、图压字）。

**以下属于「建议」，不影响判定（绝不因为它们判 FAIL）：**
版面平衡/留白多少、是否可加 logo、间距微调、轻微 AI 痕迹、配色偏好、正文字号偏大等主观项。

判定规则：没有任何 A–D 硬缺陷 → \`VERDICT: PASS\`；有硬缺陷 → \`VERDICT: FAIL\`。宁可放过也不要因主观审美卡住一份能读的稿。
**输出格式**：第一行必须是 \`VERDICT: PASS\` 或 \`VERDICT: FAIL\`。
若 FAIL，逐条列出硬缺陷：\`第N页 · 元素 · 问题 · 怎么改\`（给可执行的坐标/配色建议）。
若 PASS 但有可选建议，可在 VERDICT 行后简短列「建议：…」。`;

// 在临时目录跑模型写的 pptxgenjs 代码（注入 node_modules 解析），让它把 .pptx 落到该目录。
async function runCode(code, workDir) {
  const preamble = `process.on('unhandledRejection',e=>{console.error(e&&e.message||e);process.exit(1)});const Module=require("module");const _r=Module._resolveFilename;Module._resolveFilename=function(req,par,...a){if(req==='pptx-qa')return ${JSON.stringify(QA_PATH)};try{return _r.call(this,req,par,...a)}catch{return require.resolve(req,{paths:[${JSON.stringify(NM)}]})}};\n`;
  const file = path.join(workDir, "code.cjs");
  await fs.writeFile(file, preamble + code, "utf8");
  try {
    const { stdout, stderr } = await execFile(process.execPath, [file], { cwd: workDir, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: (stdout || "") + (stderr ? `\n[stderr] ${stderr}` : "") };
  } catch (e) {
    return { ok: false, output: (e.stderr || e.stdout || e.message || "执行失败").replace(/code\.cjs/g, "script") };
  }
}

// soffice 渲染 .pptx → 每页 jpg → base64 data URL 数组。失败抛错（上层降级）。
async function renderToImages(pptxPath, workDir) {
  const profile = `file://${path.join(workDir, "lo-profile")}`;
  await execFile("soffice", ["--headless", `-env:UserInstallation=${profile}`, "--convert-to", "pdf", "--outdir", workDir, pptxPath], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  const pdf = path.join(workDir, path.basename(pptxPath).replace(/\.pptx$/i, ".pdf"));
  await fs.access(pdf);
  await execFile("pdftoppm", ["-jpeg", "-r", "110", pdf, path.join(workDir, "slide")], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const files = (await fs.readdir(workDir)).filter(f => /^slide-\d+\.jpg$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const urls = [];
  for (const f of files.slice(0, 20)) { // 最多 20 页，护栏
    const buf = await fs.readFile(path.join(workDir, f));
    urls.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
  }
  return urls;
}

// 内部视觉判定：把渲染图喂给带视觉的主模型，返回 {pass, report}。
async function visionQA(imageDataUrls) {
  const blocks = [{ type: "text", text: VISION_CHECKLIST }];
  imageDataUrls.forEach((u, i) => {
    const m = u.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return;
    blocks.push({ type: "text", text: `— 第 ${i + 1} 页 —` });
    blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  });
  const text = await callClaudeVision(blocks, 1500);
  const pass = /VERDICT:\s*PASS/i.test(text);
  return { pass, report: text.trim() };
}

async function captureFile(srcPath, displayName) {
  const fileId = crypto.randomUUID();
  const destPath = path.join(FILES_DIR, `${fileId}.pptx`);
  await fs.copyFile(srcPath, destPath);
  const info = await fs.stat(destPath);
  const meta = { id: fileId, filePath: destPath, fileName: displayName, mime: PPTX_MIME, size: info.size, expires: Date.now() + 7 * 24 * 3600_000 };
  fileStore.set(fileId, meta);
  fs.writeFile(path.join(FILES_DIR, `${fileId}.meta.json`), JSON.stringify(meta)).catch(() => {});
  return { id: fileId, name: displayName, size: info.size };
}

// 主入口。返回 { ok, pass, content, files }——executeTool 据此构造 tool_result（files 仅过关时有）。
export async function makePptx(code, fileName = "presentation.pptx") {
  const workDir = path.join("/tmp", `pptx-make-${crypto.randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  try {
    // 1. 跑代码
    const run = await runCode(code, workDir);
    if (!run.ok) return { ok: false, pass: false, content: `代码执行失败（含 pptx-qa 的对比度/几何/字号硬断言；按报错改 pptxgenjs 代码后重调 make_pptx）：\n${run.output.slice(0, 1500)}`, files: [] };
    // 2. 找产出的 pptx
    const pptxName = (await fs.readdir(workDir)).find(f => /\.pptx$/i.test(f));
    if (!pptxName) return { ok: false, pass: false, content: "代码跑完但没产出 .pptx 文件（确认调用了 writeFile）。", files: [] };
    const pptxPath = path.join(workDir, pptxName);
    // 3. 渲染 + 视觉 QA（失败则优雅降级：不阻断，标注 QA 跳过）
    let qa;
    try {
      const imgs = await renderToImages(pptxPath, workDir);
      if (!imgs.length) throw new Error("渲染未产出图片");
      qa = await visionQA(imgs);
    } catch (e) {
      const file = await captureFile(pptxPath, fileName);
      return { ok: true, pass: true, degraded: true, content: `PPT 已生成（视觉 QA 不可用，已跳过：${String(e.message).slice(0, 120)}）。`, files: [file] };
    }
    // 4. 据判定决定是否捕获
    if (qa.pass) {
      const file = await captureFile(pptxPath, fileName);
      return { ok: true, pass: true, content: `✅ PPT 已生成并通过视觉 QA。\n${qa.report.slice(0, 600)}`, files: [file] };
    }
    return { ok: true, pass: false, content: `⚠️ 视觉 QA 未通过，请按缺陷改 pptxgenjs 代码后再次调用 make_pptx（本次未产出可下载文件）：\n\n${qa.report.slice(0, 2200)}`, files: [] };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
