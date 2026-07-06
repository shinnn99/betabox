#!/usr/bin/env node
// CI guard: chặn caller mới sử dụng RPC v1 `apply_camera_probes` (deprecated).
//
// Bằng chứng B1.1a (2026-07-07):
//   - MCP prod: apply_camera_probes có PUBLIC EXECUTE → leak PATH cross-tenant.
//   - Migration 20260707140100 tạo apply_camera_probes_v2 với tenant filter.
//   - Migration 20260707140300 REVOKE ALL FROM PUBLIC/anon/authenticated.
//   - src/ hiện có 0 caller v1 (grep confirmed).
//
// Ngày dự kiến DROP v1: 2026-07-21 (2 tuần sau B1.1a) nếu grep còn 0.
// Migration DROP sẽ ở version >= 20260721XXXXXX.
//
// Script fail nếu:
//   - Bất kỳ file .ts/.tsx nào trong src/ chứa `apply_camera_probes"` mà
//     không phải `apply_camera_probes_v2"`. Cho phép trong docs/,
//     supabase/migrations/, scripts/.

import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(abs);
  }
  return out;
}

const files = walk(SRC, []);
const findings = [];

// Match `apply_camera_probes` là identifier hoàn chỉnh (word boundary phải),
// NHƯNG loại `apply_camera_probes_v2`.
const V1_RE = /apply_camera_probes(?!_v2)\b/;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (V1_RE.test(line)) {
      findings.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        snippet: line.trim().slice(0, 120),
      });
    }
  }
}

if (findings.length > 0) {
  console.error(
    `[check-apply-camera-probes-legacy] ${findings.length} caller(s) using DEPRECATED apply_camera_probes v1:`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
  }
  console.error(
    `\nDùng apply_camera_probes_v2 với p_organization_id thay thế. v1 dự kiến DROP 2026-07-21.`,
  );
  process.exit(1);
}
console.log(
  `[check-apply-camera-probes-legacy] 0 caller of v1 in src/. Safe to DROP v1 after 2026-07-21.`,
);
