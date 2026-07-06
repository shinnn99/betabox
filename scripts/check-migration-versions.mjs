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

// Whitelist: version + EXACT filename set. Cả version và filename phải
// khớp — chỉ chấp nhận đúng cặp historic đã biết, không cho file thứ 3
// cùng version lọt qua.
//
// Bằng chứng B0 report 2026-07-07 (docs/remediation-2026-07-b0.md):
//   MCP query prod xác nhận cả 2 file đã chạy, schema_migrations có 1
//   row với name của file B. Rename tạo drift âm khác — không thao tác
//   lịch sử. Reconciliation nằm ở:
//   supabase/migrations/20260707140000_reconcile_duplicate_20260704160000.sql
const KNOWN_HISTORIC_DUPLICATE_SETS = [
  {
    version: "20260704160000",
    files: new Set([
      "20260704160000_drop_organizations_metadata_columns.sql",
      "20260704160000_n1_indexes_for_dashboard_live_queries.sql",
    ]),
    reconcile: "20260707140000_reconcile_duplicate_20260704160000.sql",
  },
];

function whitelistMatch(version, files) {
  const entry = KNOWN_HISTORIC_DUPLICATE_SETS.find((e) => e.version === version);
  if (!entry) return null;
  if (files.length !== entry.files.size) return null;
  for (const f of files) {
    if (!entry.files.has(f.file)) return null;
  }
  return entry;
}

let failed = 0;
for (const [version, files] of Array.from(byVersion.entries()).sort()) {
  if (files.length <= 1) continue;
  const whitelist = whitelistMatch(version, files);
  if (whitelist) {
    console.warn(
      `[check-migration-versions] KNOWN historic duplicate: version ${version} (${files.length} files)`,
    );
    for (const f of files) console.warn(`  - ${f.file}`);
    console.warn(`  reconcile: ${whitelist.reconcile}`);
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
