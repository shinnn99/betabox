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

// Whitelist RỖNG kể từ 13/08/2026 — mọi version trùng đều fail.
//
// Trước đó whitelist có đúng một cặp historic (20260704160000, hai file
// _drop_organizations_metadata_columns + _n1_indexes_for_dashboard_live_
// queries). Cặp đó đã được gỡ hẳn, không còn ngoại lệ nào:
//
//   Vì sao phải gỡ: `supabase migration list --linked` ngày 13/08/2026 cho
//   thấy remote chỉ có MỘT row cho version này, nên file thứ hai bị CLI
//   xếp vào diện *pending* (dòng `{"local":"20260704160000","remote":""}`).
//   Tức là mọi `supabase db push` về sau đều sẽ tái chạy một trong hai
//   migration cũ — không ai muốn thế, kể cả khi SQL idempotent.
//
//   Vì sao gỡ được an toàn (đo trên prod 13/08/2026, không đọc ghi chú cũ):
//     * Effect file A: 5 cột legal_name/tax_code/phone/email/address đều
//       trả 42703 qua PostgREST → đã drop.
//     * Effect file B: `supabase inspect db index-sizes --linked` liệt kê
//       đủ idx_packing_events_org_business_date,
//       idx_packing_events_org_scanned_at,
//       idx_warehouse_scan_raw_events_org_received_at → đã tồn tại.
//   Cả hai effect đã có trên prod nên xoá file khỏi repo KHÔNG đổi gì ở
//   prod, và 20260707140000_reconcile_duplicate_20260704160000.sql vẫn
//   dựng lại CẢ HAI effect một cách idempotent cho fresh clone.
//
// Từ giờ: version trùng = fail, không ngoại lệ. Đặt lại whitelist là mở
// lại đúng cái cửa vừa đóng.
const KNOWN_HISTORIC_DUPLICATE_SETS = [];

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
