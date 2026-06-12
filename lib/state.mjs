// Shared runtime state — extracted from server.mjs (strangler refactor step 0).
// These Maps are singletons: every module that imports them shares the same
// reference, so writes from one place are visible everywhere.
import fs from "node:fs/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Project root = parent of lib/. Keep .generated-files at the project root,
// identical to the path server.mjs used before this extraction.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Generated file store (metadata persisted as .meta.json sidecar files)
export const fileStore = new Map();
export const FILES_DIR = path.join(projectRoot, ".generated-files");
await mkdir(FILES_DIR, { recursive: true }).catch(() => {});

// Restore fileStore from sidecar metadata on startup
try {
  const entries = await fs.readdir(FILES_DIR);
  for (const f of entries) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(FILES_DIR, f), "utf8"));
      if (Date.now() > meta.expires) {
        fs.unlink(path.join(FILES_DIR, f)).catch(() => {});
        fs.unlink(meta.filePath).catch(() => {});
      } else {
        fileStore.set(meta.id, meta);
      }
    } catch {}
  }
  if (fileStore.size) console.log(`[Files] Restored ${fileStore.size} file(s) from disk`);
} catch {}

// Long document background jobs (in-memory, expire after 2h)
export const longDocJobs = new Map();

// Periodic cleanup: expire on-disk files past TTL and stale long-doc jobs.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of fileStore) {
    if (now > entry.expires) {
      fs.unlink(entry.filePath).catch(() => {});
      fs.unlink(path.join(FILES_DIR, `${id}.meta.json`)).catch(() => {});
      fileStore.delete(id);
    }
  }
  for (const [id, job] of longDocJobs) {
    if (now - job.createdAt > 7200_000) longDocJobs.delete(id);
  }
}, 3600_000);
