#!/usr/bin/env node
// Test bug leo thang admin→owner sau fix canAssignRole (2026-07-23).
// Chạy: node scripts/test-role-escalation.mjs
//
// PHẦN 1: Unit test canAssignRole helper — verify logic pure, không qua HTTP.
//   Đủ 36 cặp (6 role actor × 6 role target).
//
// PHẦN 2: Integration test route /api/users POST qua test_admin — verify
//   guard áp helper đúng. 3 ca kích hoạt được với test user (không đụng Hạnh).
//   Bỏ qua ca cần signIn owner (Hạnh) vì script không có password.
//
// Yêu cầu: dev server chạy tại https://localhost:3000 (fix chưa deploy prod).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";

const envRaw = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
const env = {};
for (const line of envRaw.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = "https://localhost:3000";
const PASSWORD = "Test12345678";

// ─────────────────────────────────────────────────────────────────
// PHẦN 1: Unit test canAssignRole
// ─────────────────────────────────────────────────────────────────

async function unitTestHelper() {
  console.log("=== PHẦN 1: Unit test canAssignRole ===\n");
  const { canAssignRole } = await import("../src/lib/auth.ts");

  const roles = ["owner", "admin", "warehouse_manager", "shift_leader", "packer", "viewer"];
  // Expected matrix: canAssignRole(actor, target)
  // Rule: owner=true tất cả; khác = target rank < actor rank.
  // Rank: owner=100, admin=80, wm=60, shift=40, packer=20, viewer=10.
  const rank = { owner: 100, admin: 80, warehouse_manager: 60, shift_leader: 40, packer: 20, viewer: 10 };

  let pass = 0, fail = 0;
  console.log("Actor \\ Target".padEnd(20) + roles.map(r => r.slice(0, 6).padStart(8)).join(""));
  for (const actor of roles) {
    const row = [actor.padEnd(20)];
    for (const target of roles) {
      const expected = actor === "owner" ? true : rank[target] < rank[actor];
      const actual = canAssignRole(actor, target);
      const ok = expected === actual;
      row.push((ok ? (actual ? "  ok✓  " : "  no✓  ") : (actual ? " OK✗   " : " NO✗   ")).padStart(8));
      if (ok) pass++; else fail++;
    }
    console.log(row.join(""));
  }
  console.log(`\nUnit: ${pass}/${pass + fail} passed. ${fail === 0 ? "✅ Helper logic đúng." : "❌ Helper logic sai."}`);
  return fail === 0;
}

// ─────────────────────────────────────────────────────────────────
// PHẦN 2: Integration test qua route thật
// ─────────────────────────────────────────────────────────────────

async function signInAsAdmin() {
  const supabase = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email: "test_admin@betacom.local",
    password: PASSWORD,
  });
  if (error) throw new Error(`signIn fail: ${error.message}`);
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
}

function buildCookie(accessToken, refreshToken) {
  // Supabase SSR (@supabase/ssr) đọc cookie `sb-<project-ref>-auth-token`.
  // Project ref từ URL: https://<ref>.supabase.co.
  const urlMatch = SUPABASE_URL.match(/https:\/\/([^.]+)\./);
  const ref = urlMatch?.[1];
  if (!ref) throw new Error("Cannot extract project ref from SUPABASE_URL");
  const cookieName = `sb-${ref}-auth-token`;
  // Value format: base64 encode của array [access_token, refresh_token, ...].
  // @supabase/ssr accept plain JSON base64.
  const payload = JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  });
  const encoded = "base64-" + Buffer.from(payload).toString("base64");
  return `${cookieName}=${encoded}`;
}

async function createUserAs(cookie, body) {
  // Node built-in fetch dùng undici underneath; expose dispatcher via
  // globalThis.fetch không có API sạch. Dùng https module trực tiếp.
  const https = await import("node:https");
  const url = new URL(`${BASE_URL}/api/users`);
  const payload = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Cookie: cookie,
        },
        rejectUnauthorized: false, // mkcert dev cert
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let data;
          try { data = JSON.parse(chunks); } catch { data = { raw: chunks.slice(0, 200) }; }
          resolve({ status: res.statusCode, body: data });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function cleanup() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const targets = (list?.users ?? []).filter((u) => u.email?.startsWith("escalation_target_"));
  for (const u of targets) {
    await admin.from("user_profiles").delete().eq("id", u.id);
    await admin.auth.admin.deleteUser(u.id);
    console.log(`  cleanup deleted ${u.email}`);
  }
}

async function integrationTest() {
  console.log("\n=== PHẦN 2: Integration test route /api/users ===\n");
  console.log("Cleanup previous test targets...");
  await cleanup();
  console.log();

  console.log("SignIn as test_admin@betacom.local...");
  const tokens = await signInAsAdmin();
  const cookie = buildCookie(tokens.accessToken, tokens.refreshToken);
  console.log("  Cookie built.\n");

  const cases = [
    {
      name: "Ca B: Admin tạo owner (PHẢI CHẶN 403)",
      body: { email: "escalation_target_owner@betacom.local", password: PASSWORD, full_name: "Should Not Exist", role: "owner" },
      expectStatus: 403,
      expectError: "forbidden_role_escalation",
    },
    {
      name: "Ca D: Admin tạo warehouse_manager (PHẢI PASS 201)",
      body: { email: "escalation_target_wm_by_admin@betacom.local", password: PASSWORD, full_name: "WM by Admin", role: "warehouse_manager" },
      expectStatus: 201,
    },
    {
      name: "Ca E: Admin tạo admin (PHẢI CHẶN 403, ngang hàng)",
      body: { email: "escalation_target_admin@betacom.local", password: PASSWORD, full_name: "Should Not Exist", role: "admin" },
      expectStatus: 403,
      expectError: "forbidden_role_escalation",
    },
  ];

  const results = [];
  for (const c of cases) {
    const res = await createUserAs(cookie, c.body);
    const statusOk = res.status === c.expectStatus;
    const errorOk = !c.expectError || res.body.error === c.expectError;
    const passed = statusOk && errorOk;
    const verdict = passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${verdict}  ${c.name}`);
    console.log(`      target_role=${c.body.role} → status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    results.push(passed);
  }

  console.log("\nCleanup test targets...");
  await cleanup();

  const passed = results.filter(Boolean).length;
  console.log(`\nIntegration: ${passed}/${results.length} passed.`);
  return passed === results.length;
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

async function main() {
  const unitOk = await unitTestHelper();
  if (!unitOk) {
    console.error("\n❌ Unit test fail — không chạy integration. Fix helper trước.");
    process.exit(1);
  }
  const intOk = await integrationTest();
  console.log(`\n=== Overall: ${unitOk && intOk ? "✅ ALL PASS" : "❌ FAIL"} ===`);
  process.exit(unitOk && intOk ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
