// Seed 1 org test rỗng + 1 auth.user thật (qua Supabase Auth Admin API,
// không insert SQL thô — user phải là session hợp lệ THẬT để test Ca 2
// cross-org kết luận chuyển sang production được) + 1 user_profile
// gắn org test với role viewer.
//
// Chạy: node scripts/auth-test/seed.mjs
// Dọn: node scripts/auth-test/cleanup.mjs
//
// KHÔNG để user test tồn tại quá ~30 phút — sau test xong xóa liền.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", "..", ".env.local");
const envRaw = readFileSync(envPath, "utf8");
const env = Object.fromEntries(
  envRaw
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_ID = "99999999-9999-9999-9999-999999999999";
const ORG_NAME = "__auth_test_org_delete_me__";
const ORG_SLUG = "__auth-test-delete-me__";
const USER_EMAIL = "authtest@delete-me.local";
const USER_PASSWORD = "TestPass123!";

async function main() {
  console.log("[seed] insert org test rỗng...");
  const { error: orgErr } = await admin.from("organizations").insert({
    id: ORG_ID,
    name: ORG_NAME,
    slug: ORG_SLUG,
    status: "active",
  });
  if (orgErr && !orgErr.message.includes("duplicate")) {
    console.error("org insert failed:", orgErr);
    process.exit(1);
  }
  console.log(`  org_id=${ORG_ID}`);

  console.log("[seed] tạo auth.user qua Auth Admin API...");
  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email: USER_EMAIL,
    password: USER_PASSWORD,
    email_confirm: true,
  });
  if (userErr) {
    if (userErr.message.includes("already been registered")) {
      const { data: list } = await admin.auth.admin.listUsers();
      const existing = list?.users.find((u) => u.email === USER_EMAIL);
      if (existing) {
        console.log(`  reuse existing user_id=${existing.id}`);
        await seedProfile(existing.id);
        printReady(existing.id);
        return;
      }
    }
    console.error("createUser failed:", userErr);
    process.exit(1);
  }
  const userId = created.user.id;
  console.log(`  user_id=${userId} email=${USER_EMAIL}`);

  await seedProfile(userId);
  printReady(userId);
}

async function seedProfile(userId) {
  console.log("[seed] insert user_profile (role=viewer, org=test)...");
  const { error: profErr } = await admin.from("user_profiles").upsert({
    id: userId,
    organization_id: ORG_ID,
    role: "viewer",
    full_name: "Auth Test User (delete me)",
    status: "active",
  });
  if (profErr) {
    console.error("profile insert failed:", profErr);
    process.exit(1);
  }
}

function printReady(userId) {
  console.log("");
  console.log("[seed] READY. Test credentials:");
  console.log(`  email:    ${USER_EMAIL}`);
  console.log(`  password: ${USER_PASSWORD}`);
  console.log(`  org:      ${ORG_NAME} (${ORG_ID})`);
  console.log(`  role:     viewer`);
  console.log(`  user_id:  ${userId}`);
  console.log("");
  console.log("[seed] Ca 2 test:");
  console.log("  1. Browser private → https://localhost:3000/login");
  console.log(`     login ${USER_EMAIL} / ${USER_PASSWORD}`);
  console.log("  2. Curl retry với cookie session của user này:");
  console.log("     (hoặc mở /dashboard/videos, tìm đơn bcacfa25-9059-40d8-b368-df9134a3bbc1 bấm Xem)");
  console.log("");
  console.log("[seed] Kỳ vọng: watch → state=failed error=cross_org_access_denied");
  console.log("                retry curl → HTTP 403 cross_org_access_denied");
  console.log("");
  console.log("[seed] XONG TEST → chạy ngay: node scripts/auth-test/cleanup.mjs");
  console.log("       Không để user test nằm lại quá 30 phút.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
