#!/usr/bin/env node
// Tạo 5 tài khoản test cho org 1 Betacom — 1 mỗi role (trừ owner).
// Chạy: node scripts/create-test-users.mjs
//
// Idempotent: user đã tồn tại (email trùng) → skip + log.
// Rollback tay: DELETE FROM user_profiles WHERE full_name LIKE 'Test %';
//               + admin.auth.admin.deleteUser cho từng id (script riêng nếu cần).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";

// Load .env.local thủ công (script standalone, không qua Next).
const envPath = path.resolve(process.cwd(), ".env.local");
const envRaw = readFileSync(envPath, "utf8");
const env = {};
for (const line of envRaw.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const ORG_ID = "00000000-0000-0000-0000-000000000001"; // Betacom test
const PASSWORD = "Test12345678";
const USERS = [
  { role: "admin",             email: "test_admin@betacom.local",  full_name: "Test Admin" },
  { role: "warehouse_manager", email: "test_wm@betacom.local",     full_name: "Test WM" },
  { role: "shift_leader",      email: "test_shift@betacom.local",  full_name: "Test Shift Leader" },
  { role: "packer",            email: "test_packer@betacom.local", full_name: "Test Packer" },
  { role: "viewer",            email: "test_viewer@betacom.local", full_name: "Test Viewer" },
];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createOne({ role, email, full_name }) {
  // 1. Check email đã tồn tại chưa (idempotent).
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = existing?.users?.find((u) => u.email === email);
  if (found) {
    console.log(`SKIP ${email} — user đã tồn tại (id=${found.id})`);
    return { skipped: true, id: found.id };
  }

  // 2. Tạo auth user.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    console.error(`FAIL ${email} — auth create: ${createErr?.message}`);
    return { error: createErr?.message };
  }

  // 3. Tạo user_profiles.
  const { error: profileErr } = await admin.from("user_profiles").insert({
    id: created.user.id,
    organization_id: ORG_ID,
    role,
    full_name,
    status: "active",
  });
  if (profileErr) {
    // Rollback auth user (không có mồ côi).
    await admin.auth.admin.deleteUser(created.user.id);
    console.error(`FAIL ${email} — profile insert: ${profileErr.message} (rolled back auth)`);
    return { error: profileErr.message };
  }

  console.log(`OK   ${email.padEnd(35)} role=${role.padEnd(20)} id=${created.user.id}`);
  return { id: created.user.id };
}

async function main() {
  console.log(`Creating ${USERS.length} test users for org ${ORG_ID}...`);
  console.log(`Password (all): ${PASSWORD}\n`);
  for (const u of USERS) {
    await createOne(u);
  }
  console.log("\nVerify:");
  const { data: profiles } = await admin
    .from("user_profiles")
    .select("id, full_name, role, status, organization_id")
    .eq("organization_id", ORG_ID)
    .like("full_name", "Test %");
  console.table(profiles);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
