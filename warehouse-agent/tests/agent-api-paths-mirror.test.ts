import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_API_PATHS as AGENT_PATHS } from "../src/agent-api-paths";

// ============================================================================
// Mirror check: warehouse-agent/src/agent-api-paths.ts phải khớp
// src/lib/warehouse/agent-api-paths.ts (backend).
//
// Không import backend module vì bên đó có "server-only" — không load
// được từ agent runtime. Cách check: parse literal { key: "path" } từ
// file backend bằng regex đơn giản, compare object.
// ============================================================================

function loadBackendPaths(): Record<string, string> {
  // agent dir = warehouse-agent/, backend file = ../src/lib/warehouse/agent-api-paths.ts.
  const backendFile = path.resolve(
    process.cwd(),
    "..",
    "src",
    "lib",
    "warehouse",
    "agent-api-paths.ts",
  );
  const src = readFileSync(backendFile, "utf8");
  const match = src.match(
    /export const AGENT_API_PATHS\s*=\s*{([\s\S]*?)}\s*as const;/,
  );
  if (!match) throw new Error("mirror-check: parse AGENT_API_PATHS failed");
  const bodyRaw = match[1];
  const out: Record<string, string> = {};
  // Format expected: `  key: "value",` — bỏ dòng chỉ comment.
  const lineRe = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*"([^"]+)"\s*,?\s*$/;
  for (const line of bodyRaw.split("\n")) {
    const m = line.match(lineRe);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test("mirror: agent AGENT_API_PATHS khớp backend", () => {
  const backend = loadBackendPaths();
  const agent = AGENT_PATHS as unknown as Record<string, string>;
  assert.deepStrictEqual(
    { ...agent },
    backend,
    "agent-api-paths.ts (agent) không khớp backend — sửa cả 2 bên",
  );
});
