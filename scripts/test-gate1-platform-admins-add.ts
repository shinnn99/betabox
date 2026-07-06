// Gate 1: smoke test /api/platform/admins/add (route thêm platform admin).
// Chứng minh: TENANT không add được platform admin (guard route chặn).
//
// 3 ca:
//   1. Không session (không cookie) → 401 unauthenticated (proxy tầng auth)
//   2. Session tenant thường (không platform admin) → 403 forbidden_platform_only
//   3. Session tenant + body invalid → 403 (guard chặn TRƯỚC validation
//      — dấu hiệu tốt: gate cứng, không lộ signal validation cho tenant)
//
// Ca "support gọi → 403 forbidden_role" cọc tới khi có platform_support seed.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_A = "cc333333-3333-3333-3333-333333333333";
const TENANT_EMAIL = `__test_gate1_tenant_${Date.now()}@test.local`;
const TENANT_PASSWORD = "test-gate1-pw-1234567890";

async function cleanup() {
  await admin.from("user_profiles").delete().like("full_name", "__test_gate1_%");
  const { data: users } = await admin.auth.admin.listUsers();
  for (const u of users?.users ?? []) {
    if (u.email && u.email.startsWith("__test_gate1_")) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }
  await admin.from("organizations").delete().like("name", "__test_gate1_%");
}

async function setup() {
  console.log("Setup: creating org + tenant user...");
  await admin.from("organizations").insert({
    id: ORG_A,
    name: "__test_gate1_A",
    slug: `__test_gate1_a_${Date.now()}`,
  });
  const { data: userData, error } = await admin.auth.admin.createUser({
    email: TENANT_EMAIL,
    password: TENANT_PASSWORD,
    email_confirm: true,
  });
  if (error || !userData.user) throw new Error(`createUser: ${error?.message}`);

  await admin.from("user_profiles").insert({
    id: userData.user.id,
    organization_id: ORG_A,
    role: "owner",
    full_name: "__test_gate1_tenant_owner",
    status: "active",
  });
  return userData.user.id;
}

async function loginTenant(): Promise<string> {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON },
    body: JSON.stringify({ email: TENANT_EMAIL, password: TENANT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function makeCookieHeader(accessToken: string): string {
  const projectRef = new URL(SUPA_URL).hostname.split(".")[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const cookieValue = encodeURIComponent(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "fake-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: "bearer",
    })
  );
  return `${cookieName}=${cookieValue}`;
}

async function main() {
  await cleanup();
  await setup();

  try {
    // === CA 1: KHÔNG session → 401 unauthenticated (proxy chặn) ===
    console.log("\n=== CA 1: Không session ===");
    const res1 = await fetch("https://localhost:3000/api/platform/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", role: "platform_owner" }),
      // @ts-expect-error
      redirect: "manual",
    });
    const body1 = await res1.text();
    console.log(`status=${res1.status}`);
    console.log(`body: ${body1}`);
    const ca1_pass = res1.status === 401 && body1.includes("unauthenticated");
    console.log(ca1_pass ? "✓ CA 1 PASS" : "✗ CA 1 FAIL");

    // === CA 2: Session tenant thường → 403 forbidden_platform_only ===
    console.log("\n=== CA 2: Session tenant (không platform admin) ===");
    const accessToken = await loginTenant();
    const cookieHeader = makeCookieHeader(accessToken);
    const res2 = await fetch("https://localhost:3000/api/platform/admins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", role: "platform_owner" }),
      // @ts-expect-error
      redirect: "manual",
    });
    const body2 = await res2.text();
    console.log(`status=${res2.status}`);
    console.log(`body: ${body2}`);
    const ca2_pass = res2.status === 403 && body2.includes("forbidden_platform_only");
    console.log(ca2_pass ? "✓ CA 2 PASS" : "✗ CA 2 FAIL");

    // === CA 3: Session tenant + body invalid → 403 (guard chặn trước validation) ===
    console.log("\n=== CA 3: Session tenant + body invalid (verify gate CHẶN TRƯỚC validation) ===");
    const res3 = await fetch("https://localhost:3000/api/platform/admins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: cookieHeader,
      },
      body: "garbage-not-json",
      // @ts-expect-error
      redirect: "manual",
    });
    const body3 = await res3.text();
    console.log(`status=${res3.status}`);
    console.log(`body: ${body3}`);
    const ca3_pass = res3.status === 403 && body3.includes("forbidden_platform_only");
    console.log(ca3_pass ? "✓ CA 3 PASS (gate chặn trước validation)" : "✗ CA 3 FAIL");

    console.log("\n=== SUMMARY ===");
    const allPass = ca1_pass && ca2_pass && ca3_pass;
    console.log(allPass ? "✓ GATE 1 XANH — route add chặn tenant/no-session đúng" : "✗ GATE 1 FAIL");
  } finally {
    await cleanup();
  }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
