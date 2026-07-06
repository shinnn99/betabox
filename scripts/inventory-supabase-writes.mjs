#!/usr/bin/env node
// Inventory Supabase mutable writes (insert/update/delete/upsert) trong
// src/ không destructure `.error`.
//
// HIGH-15: phần scope A3 chỉ fix critical positions (audit.ts, staff,
// watch, platform/admins/*, HIGH-7/8/9/10). Vòng B sẽ xử toàn bộ. Script
// này in ra danh sách để phân loại business-critical / audit-critical /
// telemetry.
//
// LƯU Ý: heuristic — không AST full. Match false-positive:
//   - .insert() bên trong chain đã có destructure `{ error }` ở dòng trên.
//   - .update({...}) trên object không phải Supabase (VD state.update(...)).
// False-negative:
//   - Write spanning nhiều dòng mà destructure ở dòng cuối.
//
// Mục tiêu: có bản đồ, không tự động fix. Đọc output để phân loại tay.

import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SRC = path.join(ROOT, "src");

const WRITE_METHOD_RE = /\.(insert|update|delete|upsert)\s*\(/g;

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

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  // Simplistic detector: mỗi lần match .insert(/.update(/.delete(/.upsert(
  // là 1 write. Nhìn 5 dòng trước và 3 dòng sau xem có `.from(` (khẳng định
  // Supabase chain) VÀ có `{ error` hoặc `.error` trong await chain.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    WRITE_METHOD_RE.lastIndex = 0;
    let m;
    while ((m = WRITE_METHOD_RE.exec(line))) {
      // Check upstream có .from( trong 5 dòng gần đây.
      const start = Math.max(0, i - 5);
      const upstream = lines.slice(start, i + 1).join("\n");
      if (!/\.from\(/.test(upstream)) continue;
      // Bỏ Map/Set/Array .delete
      const before = line.slice(0, m.index);
      if (/\b(map|Map|set|Set|array|arr|list)\b\.$/i.test(before.trim())) continue;

      // Nhìn 15 dòng gần đây (before write) để tìm await chain start.
      // Nếu chain có `const { data, error }` hoặc `const { error }` → OK.
      // Nếu chain chỉ có `await admin.from(...)` không destruct → flag.
      const contextStart = Math.max(0, i - 15);
      const contextEnd = Math.min(lines.length, i + 5);
      const context = lines.slice(contextStart, contextEnd).join("\n");

      // Heuristic: có "{ error" hoặc "{ data, error" hoặc "{ error:" trong 15 dòng trước
      // hoặc 5 dòng sau (chain result assign) → coi như destructured.
      const hasDestructure =
        /const\s+\{\s*(?:data\s*(?::\s*\w+)?\s*,\s*)?error/.test(context) ||
        /\{\s*(?:data\s*(?::\s*\w+)?\s*,\s*)?error\s*(?::\s*\w+)?\s*\}\s*=\s*await/.test(
          context,
        );
      if (hasDestructure) continue;

      findings.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        method: m[1],
        snippet: line.trim().slice(0, 120),
      });
    }
  }
}

const grouped = new Map();
for (const f of findings) {
  const arr = grouped.get(f.file) ?? [];
  arr.push(f);
  grouped.set(f.file, arr);
}

console.log(`\n[inventory-supabase-writes] ${findings.length} write(s) without visible .error destructure across ${grouped.size} file(s):\n`);
for (const [file, items] of Array.from(grouped.entries()).sort()) {
  console.log(`  ${file}`);
  for (const it of items) {
    console.log(`    L${it.line} .${it.method}(  ${it.snippet}`);
  }
}
console.log("\nNote: heuristic — có thể false-positive nếu destructure ở dòng sau 5 dòng, hoặc dùng try/catch làm outer catch.");
console.log("Dùng để phân loại tay: business-critical / audit-critical / telemetry / false-positive.\n");
