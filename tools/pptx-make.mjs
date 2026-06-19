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

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const VISION_CHECKLIST = `你是 PPT 视觉质检员。下面是一份演示文稿逐页渲染图。逐页检查这些「用户一眼可见」的缺陷：
1. 隐形/低对比文字：浅色或强调色压浅底、深色压深底（重点查卡片标题、网址、底部标签行）。
2. 文字溢出/截断：文字超出文本框、被边缘裁掉、标题折行后撞到下方副标题。
3. 装饰压字：圆形/色块等装饰与文字相交导致难读。
4. 卡片不一致：一排同级卡片里出现无逻辑的单独深色/异色卡。
5. AI 痕迹：标题下强调横线、左侧竖色条。
6. 版面失衡：内容挤上半屏、下半大片空白；元素间距忽大忽小；明显溢出画布被裁。
7. 字号层级：正文是否过大（应 ~14-16pt）。
只报「真的会让人觉得难看或读不了」的问题，忽略亚像素。
**输出格式**：第一行必须是 \`VERDICT: PASS\` 或 \`VERDICT: FAIL\`。
若 FAIL，随后逐条列出：\`第N页 · 元素 · 问题 · 怎么改\`（给可执行的坐标/配色建议）。`;

// 在临时目录跑模型写的 pptxgenjs 代码（注入 node_modules 解析），让它把 .pptx 落到该目录。
async function runCode(code, workDir) {
  const preamble = `const Module=require("module");const _r=Module._resolveFilename;Module._resolveFilename=function(req,par,...a){try{return _r.call(this,req,par,...a)}catch{return require.resolve(req,{paths:[${JSON.stringify(NM)}]})}};\n`;
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
    if (!run.ok) return { ok: false, pass: false, content: `代码执行失败（含 track() 越界断言）：\n${run.output.slice(0, 1500)}`, files: [] };
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
