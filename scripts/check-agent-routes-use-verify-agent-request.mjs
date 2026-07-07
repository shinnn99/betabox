#!/usr/bin/env node
// CI guard Lát A HMAC v2 rollout: tất cả route agent-authenticated PHẢI
// dùng `verifyAgentRequest` (dual v1+v2), KHÔNG được import legacy
// `verifyAgentSignature` (v1-only). `verifyAgentSignature` giữ trong
// agent-auth.ts để test v1 canonical + kèm helper `verifyAgentRequest`,
// nhưng route mới không được gọi nữa — nếu không sau Lát B enforce v2
// route đó sẽ break im lặng.
//
// Rule: file trong src/app/api/agent/** hoặc src/app/api/warehouse/**
// mà có gọi `readAgentHeaders` PHẢI có `verifyAgentRequest` VÀ không
// `verifyAgentSignature`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

const SCAN_DIRS = [
  path.join(ROOT, "src", "app", "api", "agent"),
  path.join(ROOT, "src", "app", "api", "warehouse"),
];

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && full.endsWith(".ts")) yield full;
  }
}

let violations = 0;
let checked = 0;

for (const dir of SCAN_DIRS) {
  try {
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    const usesAgentHeaders = src.includes("readAgentHeaders");
    if (!usesAgentHeaders) continue;
    checked++;
    const usesRequest = src.includes("verifyAgentRequest");
    const usesLegacy = /verifyAgentSignature\b/.test(src);
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (!usesRequest) {
      console.error(
        `[check-agent-routes-v2] ${rel}: dùng readAgentHeaders nhưng thiếu verifyAgentRequest`,
      );
      violations++;
    }
    if (usesLegacy) {
      console.error(
        `[check-agent-routes-v2] ${rel}: dùng verifyAgentSignature (legacy v1-only). Chuyển sang verifyAgentRequest.`,
      );
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`[check-agent-routes-v2] FAIL (${violations} vi phạm trên ${checked} file agent-authenticated).`);
  process.exit(1);
}
console.log(`[check-agent-routes-v2] ${checked} route agent-authenticated pass.`);
