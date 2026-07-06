#!/usr/bin/env node
// CI guard: 2 file migration cùng version → drift schema_migrations.
//
// Bằng chứng B0 2026-07-07: version 20260704160000 có 2 file:
//   - _drop_organizations_metadata_columns.sql
//   - _n1_indexes_for_dashboard_live_queries.sql
// Cả 2 đã chạy trên prod nhưng `schema_migrations` chỉ ghi 1 row với
// name của file thứ 2 (alphabet). Đây là drift âm — không detect được
// qua CLI, phải grep filename.
//
// Script này grep filename theo pattern <14-digit>_<name>.sql, group
// theo 14-digit version, fail nếu group nào > 1 file.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");

const VERSION_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const byVersion = new Map();
for (const f of readdirSync(MIG_DIR)) {
  const m = VERSION_RE.exec(f);
  if (!m) continue;
  const [, version, name] = m;
  const arr = byVersion.get(version) ?? [];
  arr.push({ file: f, name });
  byVersion.set(version, arr);
}

// Bỏ qua: version đã biết là drift lịch sử (đã chạy prod trước 2026-07-07).
// Duplicate mới sau ngày đó phải fail. Chấp nhận exception qua env var
// để tạm thời (VD trong B1 khi tạo reconciliation), nhưng phải log rõ.
const KNOWN_HISTORIC_DUPLICATES = new Set([
  // 20260704160000: bằng chứng MCP query 2026-07-07 — cả A + B đã chạy prod,
  // schema_migrations chỉ ghi row cho file `_n1_indexes...`. Không rename
  // (drift risk). Chỉ chấp nhận exception; migration reconciliation sẽ
  // được viết trong B1 với version mới.
  "20260704160000",
]);

let failed = 0;
for (const [version, files] of Array.from(byVersion.entries()).sort()) {
  if (files.length <= 1) continue;
  if (KNOWN_HISTORIC_DUPLICATES.has(version)) {
    console.warn(
      `[check-migration-versions] KNOWN historic duplicate: version ${version} (${files.length} files)`,
    );
    for (const f of files) console.warn(`  - ${f.file}`);
    continue;
  }
  console.error(
    `[check-migration-versions] DUPLICATE version ${version} (${files.length} files):`,
  );
  for (const f of files) console.error(`  - ${f.file}`);
  failed++;
}

if (failed > 0) {
  console.error(
    `\n[check-migration-versions] ${failed} version(s) with duplicate files. schema_migrations sẽ drift; đổi tên hoặc gộp trước khi commit.`,
  );
  process.exit(1);
}
console.log(
  `[check-migration-versions] ${byVersion.size} version(s) checked, 0 new duplicates.`,
);
