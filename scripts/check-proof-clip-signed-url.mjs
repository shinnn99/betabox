#!/usr/bin/env node
/**
 * N2 DiD-A grep-CI: cấm mọi lời gọi `.createSignedUrl(` trong repo NGOẠI
 * TRỪ helper duy nhất `src/lib/watch/proof-clip-signed-url.ts`.
 *
 * Vì sao: multi-tenant chung một Supabase project + chung bucket
 * `proof-clips-transient` → route nào cầm bucket_path và gọi createSignedUrl
 * mà quên verify org = lộ chéo. Helper tự verify org bên trong. Route mới
 * đẻ ra quên verify sẽ bị CI chặn ở đây trước khi merge.
 *
 * Chạy: node scripts/check-proof-clip-signed-url.mjs
 * Exit 1 nếu có violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const ALLOWED = new Set([
  normalize("src/lib/watch/proof-clip-signed-url.ts"),
]);

const SCAN_ROOTS = ["src"];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  ".git",
]);

const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function normalize(p) {
  return p.split(/[\\/]/).join("/");
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, files);
    } else if (st.isFile()) {
      const ext = entry.slice(entry.lastIndexOf("."));
      if (EXTS.has(ext)) files.push(full);
    }
  }
  return files;
}

const violations = [];
for (const root of SCAN_ROOTS) {
  const abs = join(REPO_ROOT, root);
  try {
    statSync(abs);
  } catch {
    continue;
  }
  for (const file of walk(abs)) {
    const rel = normalize(relative(REPO_ROOT, file).split(sep).join("/"));
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    // Chỉ match lời gọi `.createSignedUrl(` — dấu chấm + tên + mở ngoặc.
    // Bỏ qua comment nhắc lệnh cấm và string literal (không có dấu chấm
    // đứng ngay trước identifier).
    const re = /\.createSignedUrl\s*\(/g;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (re.test(line)) {
        violations.push({ file: rel, line: i + 1, text: line.trim() });
      }
      re.lastIndex = 0;
    }
  }
}

if (violations.length > 0) {
  console.error(
    "N2 DiD-A violation: `.createSignedUrl(` được gọi ngoài helper duy nhất\n" +
      "  src/lib/watch/proof-clip-signed-url.ts\n\n" +
      "Multi-tenant chung một bucket proof-clips-transient — mỗi lời gọi\n" +
      "createSignedUrl phải verify org NGƯỜI GỌI vs org của clip trước khi\n" +
      "cấp URL. Chuyển caller sang helper:\n" +
      "  import { createProofClipSignedUrlByPackingEvent, createProofClipSignedUrlByClipId }\n" +
      "    from '@/lib/watch/proof-clip-signed-url';\n\n" +
      "Vi phạm:",
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `N2 DiD-A OK: 0 lời gọi \`.createSignedUrl(\` ngoài helper (đã quét ${SCAN_ROOTS.join(", ")}).`,
);
