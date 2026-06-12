// Code execution sandbox — extracted from server.mjs (strangler refactor).
// Runs JS (.cjs with project node_modules) / Python in a temp dir, captures
// generated images + downloadable office/pdf/zip/csv files into the file store.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fileStore, FILES_DIR } from "../lib/state.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function executeCode(language, code) {
  const { execFile } = await import("node:child_process");
  const { writeFile, unlink, readFile, readdir, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  // Create a temp working directory for this execution
  const workDir = path.join(tmpdir(), `claude-exec-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const ext = language === "python" ? "py" : "cjs";
  const tmpFile = path.join(workDir, `code.${ext}`);

  // For JavaScript: inject require support for npm packages
  let finalCode = code;
  if (language !== "python") {
    // .cjs supports require() natively — prepend module paths so it finds project deps
    const jsPreamble = `const Module = require("module");\nconst _origResolve = Module._resolveFilename;\nModule._resolveFilename = function(request, parent, ...args) {\n  try { return _origResolve.call(this, request, parent, ...args); } catch {\n    return require.resolve(request, { paths: [${JSON.stringify(path.join(projectRoot, "node_modules"))}] });\n  }\n};\n`;
    finalCode = jsPreamble + code;
  }

  // For Python: auto-inject Agg backend and auto-save any open figures
  if (language === "python") {
    finalCode = code;
    const preamble = `import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.font_manager as _fm\nfor _p in ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]:\n    try: _fm.fontManager.addfont(_p)\n    except: pass\nmatplotlib.rcParams["font.sans-serif"] = ["WenQuanYi Zen Hei", "Noto Sans CJK JP"] + matplotlib.rcParams["font.sans-serif"]\nmatplotlib.rcParams["axes.unicode_minus"] = False\n`;
    const postamble = `\n\n# Auto-save open matplotlib figures (skip if user already saved images)\ntry:\n    import os as _os, matplotlib.pyplot as _plt\n    _has_images = any(f.endswith((".png",".jpg",".jpeg",".svg")) for f in _os.listdir("."))\n    if not _has_images and _plt.get_fignums():\n        for _i, _fig in enumerate(_plt.get_fignums()):\n            _plt.figure(_fig).savefig(f"${workDir}/figure_{_i}.png", dpi=150, bbox_inches="tight")\nexcept Exception:\n    pass\n`;
    finalCode = preamble + code + postamble;
  }

  await writeFile(tmpFile, finalCode, "utf8");
  const cmd = language === "python" ? "python3" : process.execPath;
  const args = [tmpFile];

  return new Promise((resolve) => {
    const env = { ...process.env, MPLBACKEND: "Agg" };
    const proc = execFile(cmd, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, cwd: workDir, env }, async (err, stdout, stderr) => {
      // Scan for generated image files
      const images = [];
      try {
        const files = await readdir(workDir);
        for (const f of files) {
          if (/\.(png|jpg|jpeg|svg)$/i.test(f)) {
            const data = await readFile(path.join(workDir, f));
            const ext = path.extname(f).slice(1).toLowerCase();
            const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
            images.push(`data:${mime};base64,${data.toString("base64")}`);
          }
        }
      } catch {}

      // Scan for generated downloadable files (office docs, PDFs, ZIPs, etc.)
      const generatedFiles = [];
      const FILE_RE = /\.(docx|xlsx|pptx|pdf|zip|csv)$/i;
      const mimeMap = {
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pdf: "application/pdf", zip: "application/zip", csv: "text/csv",
      };
      const captureFile = async (srcPath, displayName) => {
        try {
          const fileId = crypto.randomUUID();
          const ext = path.extname(displayName).slice(1).toLowerCase();
          const destPath = path.join(FILES_DIR, `${fileId}.${ext}`);
          const { copyFile, stat } = await import("node:fs/promises");
          await copyFile(srcPath, destPath);
          const info = await stat(destPath);
          const meta = {
            id: fileId, filePath: destPath, fileName: displayName,
            mime: mimeMap[ext] || "application/octet-stream",
            size: info.size, expires: Date.now() + 7 * 24 * 3600_000, // 7 days
          };
          fileStore.set(fileId, meta);
          // Persist metadata sidecar for restart recovery
          fs.writeFile(path.join(FILES_DIR, `${fileId}.meta.json`), JSON.stringify(meta)).catch(() => {});
          generatedFiles.push({ id: fileId, name: displayName, size: info.size });
        } catch {}
      };
      // 1) Scan workDir for generated files
      try {
        const allFiles = await readdir(workDir);
        for (const f of allFiles) {
          if (FILE_RE.test(f)) await captureFile(path.join(workDir, f), f);
        }
      } catch {}
      // 2) Fallback: scan stdout for absolute paths to generated files outside workDir
      if (!generatedFiles.length && stdout) {
        const pathMatches = stdout.match(/\/[^\s:,"']+\.(docx|xlsx|pptx|pdf|zip|csv)/gi) || [];
        for (const p of pathMatches) {
          if (!p.startsWith(workDir)) await captureFile(p, path.basename(p));
        }
      }

      // Cleanup
      rm(workDir, { recursive: true, force: true }).catch(() => {});

      if (err) {
        // Strip the preamble/postamble line numbers from error messages
        const cleanErr = (stderr || err.message || "Execution failed").replace(/code\.(py|cjs)/g, "script");
        resolve({ output: cleanErr, error: true, images, files: generatedFiles });
      } else {
        resolve({ output: stdout + (stderr ? `\n[stderr]: ${stderr}` : ""), error: false, images, files: generatedFiles });
      }
    });
  });
}
