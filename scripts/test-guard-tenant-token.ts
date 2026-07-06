// Test ca 3 (B-trước-C) THẬT với session tenant + header token hợp lệ.
//
// Setup:
//   - Seed 2 org test (A: tenant, B: giả platform target).
//   - Seed 1 warehouse trong mỗi org (để phân biệt qua response).
//   - Seed 1 user tenant (owner org A) qua Supabase Admin API + password.
//   - Login user tenant qua REST /auth/v1/token → lấy access_token.
//   - Sign token org-context cho org B (giả sử platform ký cho tenant).
//
// Test:
//   - Ca 3a: curl /api/warehouses với session tenant, KHÔNG token → phải thấy org A warehouse.
//   - Ca 3b: curl /api/warehouses với session tenant + token cho org B → phải thấy org A warehouse
//     (chứng minh B chặn: dù có token hợp lệ, tenant vẫn ở org A, không phải org B).
//   - Nếu ca 3b trả org B warehouse → B-trước-C VỠ (token vượt qua guard cho tenant).
//
// Cleanup: xóa seed sau test.

import { createClient } from "@supabase/supabase-js";
import { signOrgContext } from "../src/lib/platform/internal-headers-core.ts";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !ANON || !SERVICE) {
  throw new Error("Missing SUPABASE env vars");
}

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_A = "aa111111-1111-1111-1111-111111111111";
const ORG_B = "bb222222-2222-2222-2222-222222222222";
const TENANT_EMAIL = `__test_guard_tenant_${Date.now()}@test.local`;
const TENANT_PASSWORD = "test-guard-pw-1234567890";

async function setup() {
  console.log("Setup: creating orgs...");
  await admin.from("organizations").insert([
    { id: ORG_A, name: "__test_guard_A", slug: `__test_guard_a_${Date.now()}` },
    { id: ORG_B, name: "__test_guard_B", slug: `__test_guard_b_${Date.now()}` },
  ]);

  console.log("Setup: seeding warehouses...");
  await admin.from("warehouses").insert([
    { organization_id: ORG_A, code: "__WH_A", name: "__test_guard_wh_A" },
    { organization_id: ORG_B, code: "__WH_B", name: "__test_guard_wh_B" },
  ]);

  console.log("Setup: creating tenant user...");
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: TENANT_EMAIL,
    password: TENANT_PASSWORD,
    email_confirm: true,
  });
  if (userError || !userData.user) {
    throw new Error(`createUser failed: ${userError?.message}`);
  }
  const tenantUserId = userData.user.id;

  console.log("Setup: seeding user_profiles (tenant owner org A)...");
  await admin.from("user_profiles").insert({
    id: tenantUserId,
    organization_id: ORG_A,
    role: "owner",
    full_name: "__test_guard_tenant_owner",
    status: "active",
  });

  console.log(`Setup: tenant user_id = ${tenantUserId}`);
  return { tenantUserId };
}

async function loginTenant(): Promise<string> {
  console.log("Login: signing in tenant via REST...");
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
    },
    body: JSON.stringify({
      email: TENANT_EMAIL,
      password: TENANT_PASSWORD,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  console.log(`Login OK: access_token length=${data.access_token.length}`);
  return data.access_token;
}

async function cleanup() {
  console.log("Cleanup: removing test data...");
  await admin.from("user_profiles").delete().like("full_name", "__test_guard_%");
  await admin.from("warehouses").delete().like("name", "__test_guard_%");
  const { data: users } = await admin.auth.admin.listUsers();
  for (const u of users?.users ?? []) {
    if (u.email && u.email.startsWith("__test_guard_")) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }
  await admin.from("organizations").delete().like("name", "__test_guard_%");
  console.log("Cleanup done.");
}

async function main() {
  await cleanup(); // clean any leftover
  const { tenantUserId: _tenantUserId } = await setup();

  try {
    const accessToken = await loginTenant();

    // Sign token org-context cho ORG_B (giả sử platform ký cho tenant — chỉ tenant có secret không có, đây test flow)
    const orgContextToken = await signOrgContext({
      orgId: ORG_B,
      timestamp: Date.now(),
      nonce: crypto.randomUUID(),
    });

    // Cookie format Supabase SSR expect
    // Simulate: session cookie sb-<projectRef>-auth-token chứa JSON stringified array [access_token, refresh_token, ...]
    // Cách đơn giản: gửi Authorization: Bearer (nếu route dùng Supabase client sẽ đọc header authorization ưu tiên?)
    // Thử cả 2 cách.

    const projectRef = new URL(SUPA_URL).hostname.split(".")[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    // Cookie value là JSON stringify session object hoặc array
    const cookieValue = encodeURIComponent(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: "fake-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: "bearer",
      })
    );
    const cookieHeader = `${cookieName}=${cookieValue}`;

    // === Ca 3a: session tenant, KHÔNG token → phải thấy warehouses org A ===
    console.log("\n=== Ca 3a: session tenant, KHÔNG org-context token ===");
    const res3a = await fetch("https://localhost:3000/api/warehouses", {
      headers: {
        cookie: cookieHeader,
        Authorization: `Bearer ${accessToken}`,
      },
      // @ts-expect-error Node fetch options
      redirect: "manual",
    });
    const body3a = await res3a.text();
    console.log(`status=${res3a.status}`);
    console.log(`body: ${body3a.slice(0, 500)}`);

    // === Ca 3b: session tenant + token cho org B → phải THẤY org A (B chặn) ===
    console.log("\n=== Ca 3b: session tenant + x-internal-org-ctx cho ORG_B ===");
    const res3b = await fetch("https://localhost:3000/api/warehouses", {
      headers: {
        cookie: cookieHeader,
        Authorization: `Bearer ${accessToken}`,
        "x-internal-org-ctx": orgContextToken,
      },
      // @ts-expect-error
      redirect: "manual",
    });
    const body3b = await res3b.text();
    console.log(`status=${res3b.status}`);
    console.log(`body: ${body3b.slice(0, 500)}`);

    // Verify: cả 2 ca phải trả CÙNG warehouse (org A). Nếu ca 3b trả org B warehouse → B-trước-C vỡ.
    console.log("\n=== VERIFY ===");
    const orgAWhInBoth =
      body3a.includes("__test_guard_wh_A") && body3b.includes("__test_guard_wh_A");
    const orgBWhInB = body3b.includes("__test_guard_wh_B");
    if (orgAWhInBoth && !orgBWhInB) {
      console.log("✓ B-trước-C: tenant có token bị bỏ, thấy org A (không org B)");
    } else {
      console.log("✗ FAILED: ca 3a org_A=", body3a.includes("__test_guard_wh_A"),
        "ca 3b org_A=", body3b.includes("__test_guard_wh_A"),
        "ca 3b org_B=", body3b.includes("__test_guard_wh_B"));
    }
  } finally {
    await cleanup();
  }
}

// Ignore self-signed cert for local dev HTTPS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
