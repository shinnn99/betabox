// Dọn seed Ca 2 auth cross-org test.
// Thứ tự: xóa auth.user (cascade user_profile do FK ON DELETE CASCADE)
//         → xóa organization (FK từ profile là RESTRICT nên phải sau).
// Verify 3 count = 0 sau xóa.

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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_ID = "99999999-9999-9999-9999-999999999999";
const USER_EMAIL = "authtest@delete-me.local";

async function main() {
  console.log("[cleanup] tìm auth.user...");
  const { data: list, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) {
    console.error("listUsers failed:", listErr);
    process.exit(1);
  }
  const testUser = list.users.find((u) => u.email === USER_EMAIL);
  if (testUser) {
    console.log(`  found user_id=${testUser.id}, xóa...`);
    const { error: delErr } = await admin.auth.admin.deleteUser(testUser.id);
    if (delErr) {
      console.error("deleteUser failed:", delErr);
      process.exit(1);
    }
    console.log("  auth.user xóa xong (user_profile cascade xóa theo)");
  } else {
    console.log("  không tìm thấy auth.user (đã xóa hoặc chưa seed)");
  }

  console.log("[cleanup] xóa organization test...");
  const { error: orgErr } = await admin.from("organizations").delete().eq("id", ORG_ID);
  if (orgErr) {
    console.error("org delete failed:", orgErr);
    process.exit(1);
  }
  console.log("  org xóa xong");

  console.log("[cleanup] verify 0 row...");
  const checks = [
    { label: "auth.user", check: async () => {
      const { data } = await admin.auth.admin.listUsers();
      return data?.users.filter((u) => u.email === USER_EMAIL).length ?? 0;
    }},
    { label: "user_profile", check: async () => {
      const { count } = await admin
        .from("user_profiles")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG_ID);
      return count ?? 0;
    }},
    { label: "organization", check: async () => {
      const { count } = await admin
        .from("organizations")
        .select("id", { count: "exact", head: true })
        .eq("id", ORG_ID);
      return count ?? 0;
    }},
  ];
  let allZero = true;
  for (const c of checks) {
    const n = await c.check();
    console.log(`  ${c.label}: ${n} row`);
    if (n !== 0) allZero = false;
  }
  console.log("");
  if (allZero) {
    console.log("[cleanup] SẠCH — 3/3 count = 0. Không còn dấu vết seed.");
  } else {
    console.error("[cleanup] CHƯA SẠCH — còn row. Kiểm tay và xóa.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
