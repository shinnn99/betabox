#!/usr/bin/env node
// Đo tốc độ POST /api/users để tìm nút thắt.
// Chia thời gian ra từng phase: signIn / request total / server-side breakdown.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import https from "node:https";

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

// Đăng nhập test_admin sẵn (nhanh hơn cả owner)
const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log("SignIn...");
const t0 = Date.now();
const { data: session, error } = await supabase.auth.signInWithPassword({
  email: "test_admin@betacom.local",
  password: PASSWORD,
});
console.log(`  signIn: ${Date.now() - t0}ms`);
if (error) { console.error(error); process.exit(1); }

const urlMatch = SUPABASE_URL.match(/https:\/\/([^.]+)\./);
const ref = urlMatch[1];
const cookieName = `sb-${ref}-auth-token`;
const payload = JSON.stringify({
  access_token: session.session.access_token,
  refresh_token: session.session.refresh_token,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: "bearer",
});
const cookie = `${cookieName}=base64-${Buffer.from(payload).toString("base64")}`;

function postCreate(body) {
  const bodyStr = JSON.stringify(body);
  const url = new URL(`${BASE_URL}/api/users`);
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          Cookie: cookie,
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          const elapsed = Date.now() - t;
          let data; try { data = JSON.parse(chunks); } catch { data = { raw: chunks.slice(0, 100) }; }
          resolve({ status: res.statusCode, ms: elapsed, body: data });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// Chạy 3 lần liên tiếp để đo cold + warm.
console.log("\nPOST /api/users x3 (test_admin tạo packer):");
for (let i = 1; i <= 3; i++) {
  const email = `bench_user_${i}_${Date.now()}@betacom.local`;
  const res = await postCreate({
    email, password: PASSWORD, full_name: `Bench ${i}`, role: "packer",
  });
  console.log(`  #${i}: ${res.ms}ms status=${res.status}`);
}

// Cleanup
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
for (const u of list.users.filter(u => u.email?.startsWith("bench_user_"))) {
  await admin.from("user_profiles").delete().eq("id", u.id);
  await admin.auth.admin.deleteUser(u.id);
}
console.log("\ncleanup done.");
