#!/usr/bin/env node
// CI guard: các mutable write có tính chất tenant-scoped PHẢI có
// `.eq("organization_id", ...)` để defense-in-depth. Script này grep
// AST-lite các route trong danh sách bắt buộc và fail nếu thiếu.
//
// Không cover 100% — chỉ chặn regression cho các finding đã fix trong
// remediation-2026-07 (HIGH-8/9/10). Mở rộng khi phát hiện route mới.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * Mỗi rule: file phải chứa mọi pattern trong `must`.
 * `label` chỉ để log rõ.
 */
/**
 * Regex chặt: kể từ dòng `.from("station_device_assignments")`, không được
 * gặp `.update(` hoặc `.delete(` hoặc `;` nào TRƯỚC khi có
 * `.eq("organization_id"`. Nếu có → assignment write không scope org.
 *
 * Với route đã fix: chain đọc từ trên xuống có `.eq("organization_id"` giữa
 * update và ; kết thúc.
 */
const rules = [
  {
    file: "src/app/api/station-devices/[id]/route.ts",
    label: "HIGH-8: DELETE station_device phải verify ownership + assignment scope org",
    must: [
      // Lookup ownership trước (block SELECT với org filter).
      /\.from\("station_devices"\)\s*\.select\([^)]*\)[\s\S]{0,300}?\.eq\("organization_id"/,
      // Assignment update chain phải có org filter trước khi block chain kết thúc bằng dấu chấm phẩy.
      /\.from\("station_device_assignments"\)[\s\S]{0,400}?\.eq\("organization_id"[\s\S]{0,200}?;/,
      // Device archive update chain phải có org filter.
      /\.from\("station_devices"\)\s*\.update\([^)]*\)[\s\S]{0,200}?\.eq\("organization_id"/,
    ],
  },
  {
    file: "src/app/api/staff/[id]/route.ts",
    label: "HIGH-9: PATCH staff verify warehouse_ids thuộc org + assignment writes scope org",
    must: [
      // Verify warehouse_ids: SELECT warehouses theo org + in(newIds).
      /\.from\("warehouses"\)[\s\S]{0,300}?\.eq\("organization_id"[\s\S]{0,100}?\.in\("id"/,
      // Assignment insert phải map organization_id vào từng row.
      /\.from\("staff_warehouse_assignments"\)\s*\.insert\([\s\S]{0,300}?organization_id:/,
      // Assignment SELECT current phải có org filter.
      /\.from\("staff_warehouse_assignments"\)\s*\.select\([\s\S]{0,300}?\.eq\("organization_id"/,
      // Assignment remove UPDATE phải có org filter.
      /\.from\("staff_warehouse_assignments"\)\s*\.update\(\{\s*unassigned_at[\s\S]{0,300}?\.eq\("organization_id"/,
      // Assignment primary UPDATE phải có org filter.
      /\.from\("staff_warehouse_assignments"\)\s*\.update\(\{\s*is_primary[\s\S]{0,300}?\.eq\("organization_id"/,
    ],
  },
];

let failed = 0;
for (const rule of rules) {
  const abs = path.join(ROOT, rule.file);
  if (!existsSync(abs)) {
    console.error(`[check-tenant-scoped-writes] MISSING FILE: ${rule.file}`);
    failed++;
    continue;
  }
  const src = readFileSync(abs, "utf8");
  for (const pat of rule.must) {
    if (!pat.test(src)) {
      console.error(
        `[check-tenant-scoped-writes] ${rule.file}\n  Missing pattern: ${pat}\n  Rule: ${rule.label}`,
      );
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n[check-tenant-scoped-writes] ${failed} check(s) failed.`);
  process.exit(1);
}
console.log(`[check-tenant-scoped-writes] all ${rules.length} rule(s) pass.`);
