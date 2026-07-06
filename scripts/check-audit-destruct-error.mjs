#!/usr/bin/env node
// CI guard HIGH-15: các helper audit / route đã fix trong Vòng A phải
// destruct .error thay vì swallow qua try/catch trên Supabase write.
//
// Không catch toàn repo — chỉ chốt các file đã fix để tránh regress.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

const rules = [
  {
    file: "src/lib/audit.ts",
    label: "HIGH-15: audit.ts phải destruct { error } từ insert, không try/catch nuốt",
    must: [
      // Có destructure `{ error }` sau `await admin`.
      /const\s+\{\s*error\s*\}\s*=\s*await\s+admin/,
      // Có nhánh `if (error)` xử lý log.
      /if\s*\(\s*error\s*\)/,
    ],
    mustNot: [
      // Không được có try{ await insert()... }catch swallow.
      // Match `try` là keyword đầu statement (đầu dòng hoặc sau `;` `{` `}`).
      /(?:^|[;\}\{])\s*try\s*\{[\s\S]{0,200}?await\s+admin\.from\("audit_logs"\)\.insert/m,
    ],
  },
  {
    file: "src/lib/platform/audit.ts",
    label: "HIGH-7/15: platform audit wrapper phải destruct error",
    must: [
      /const\s+\{\s*error\s*\}\s*=\s*await\s+admin/,
    ],
  },
  {
    file: "src/app/api/platform/admins/route.ts",
    label: "HIGH-15: admins add phải dùng logPlatformAudit, không try/catch swallow",
    must: [
      /logPlatformAudit\(/,
    ],
    mustNot: [
      /(?:^|[;\}\{])\s*try\s*\{[\s\S]{0,200}?await\s+admin\.from\("platform_audit_log"\)\.insert/m,
    ],
  },
  {
    file: "src/app/api/platform/admins/[id]/route.ts",
    label: "HIGH-15: admins remove phải dùng logPlatformAudit, không try/catch swallow",
    must: [
      /logPlatformAudit\(/,
    ],
    mustNot: [
      /(?:^|[;\}\{])\s*try\s*\{[\s\S]{0,200}?await\s+admin\.from\("platform_audit_log"\)\.insert/m,
    ],
  },
  {
    file: "src/app/api/order-proof/[pe_id]/watch/route.ts",
    label: "HIGH-15: watch route insert failed clip phải destruct error để chặn loop",
    must: [
      /const\s+\{\s*error(?::\s*\w+)?\s*\}\s*=\s*await\s+admin[\s\S]{0,300}?\.from\("order_proof_clips"\)\s*\.insert/,
    ],
  },
];

let failed = 0;
for (const rule of rules) {
  const abs = path.join(ROOT, rule.file);
  if (!existsSync(abs)) {
    console.error(`[check-audit-destruct-error] MISSING FILE: ${rule.file}`);
    failed++;
    continue;
  }
  const src = readFileSync(abs, "utf8");
  for (const pat of rule.must ?? []) {
    if (!pat.test(src)) {
      console.error(
        `[check-audit-destruct-error] ${rule.file}\n  Missing must pattern: ${pat}\n  Rule: ${rule.label}`,
      );
      failed++;
    }
  }
  for (const pat of rule.mustNot ?? []) {
    if (pat.test(src)) {
      console.error(
        `[check-audit-destruct-error] ${rule.file}\n  Forbidden pattern still present: ${pat}\n  Rule: ${rule.label}`,
      );
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n[check-audit-destruct-error] ${failed} check(s) failed.`);
  process.exit(1);
}
console.log(`[check-audit-destruct-error] all ${rules.length} rule(s) pass.`);
