// Ca 5 — Test platform impersonate (cookie-carrier, sau khi bác URL-prefix).
//
// Ba ca, trọng tâm là NỬA-ÂM:
//
//   1. Happy (nửa-dương): impersonate org A → thấy data org A. Platform vào
//      được org đang impersonate.
//   2. NỬA-ÂM platform-token (TRỌNG TÂM — đóng UNVERIFIED Gate 2): impersonate
//      org A → thấy A, KHÔNG thấy B. Chứng minh is_platform_admin() giới hạn
//      theo org-trong-token, KHÔNG bypass-quá-tay-thấy-all. Bug nguy:
//      platform admin thấy MỌI org khi chỉ nên thấy org-đang-impersonate.
//   3. Expired: token org A timestamp -6 phút → 401 org_context_expired.
//
// Yêu cầu: platform admin thật (betacomagency@gmail.com) với MFA verified
// (V5 bootstrap). Script prompt password + OTP → session AAL2 → gọi API.
//
// Chạy: node --experimental-strip-types --env-file=.env.local scripts/test-platform-impersonate.ts
//
// Không lưu access_token ra file. Cleanup 2 org test khi xong (thành công
// hoặc fail đều cleanup).

import { createClient } from "@supabase/supabase-js";
import passwordPrompt from "@inquirer/password";
import inputPrompt from "@inquirer/input";
import { signOrgContext, verifyOrgContext } from "../src/lib/platform/internal-headers-core.ts";
import { randomBytes } from "crypto";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !ANON || !SERVICE) {
  console.error("Missing SUPABASE env vars");
  process.exit(2);
}

const PLATFORM_EMAIL = "betacomagency@gmail.com";
const APP_URL = "https://localhost:3000";
const ORG_A_SLUG = "_ca5_impersonate_org_a";
const ORG_B_SLUG = "_ca5_impersonate_org_b";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ============================================================================
// Colors
// ============================================================================
const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

async function askPassword(q: string): Promise<string> {
  return (await passwordPrompt({ message: q, mask: "*" })).trim();
}

async function askOtp(q: string): Promise<string> {
  return (await inputPrompt({ message: q })).trim();
}

// ============================================================================
// Seed 2 org test + data đại diện (warehouses + orders + cameras)
// ============================================================================
interface SeedCtx {
  orgAId: string;
  orgBId: string;
  warehouseAId: string;
  warehouseBId: string;
  orderAId: string;
  orderBId: string;
  cameraAId: string;
  cameraBId: string;
}

async function cleanupExistingSeed(): Promise<void> {
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, slug")
    .in("slug", [ORG_A_SLUG, ORG_B_SLUG]);
  if (!orgs || orgs.length === 0) return;
  console.log(`${C.yellow}Cleanup seed cũ (${orgs.length} org)...${C.reset}`);
  for (const org of orgs) {
    // Delete children first (theo FK)
    for (const t of ["order_proof_clips", "packing_events", "cameras", "orders", "warehouses"]) {
      await admin.from(t).delete().eq("organization_id", org.id);
    }
    await admin.from("organizations").delete().eq("id", org.id);
  }
}

async function seed(): Promise<SeedCtx> {
  console.log(`\n${C.cyan}${C.bold}━━━ SEED 2 org test + data đại diện${C.reset}`);

  const { data: orgA } = await admin
    .from("organizations")
    .insert({ name: "_Ca5 Impersonate Org A", slug: ORG_A_SLUG })
    .select()
    .single();
  const { data: orgB } = await admin
    .from("organizations")
    .insert({ name: "_Ca5 Impersonate Org B", slug: ORG_B_SLUG })
    .select()
    .single();
  if (!orgA || !orgB) throw new Error("Seed org fail");

  const { data: whA } = await admin
    .from("warehouses")
    .insert({ organization_id: orgA.id, code: "_CA5_WH_A", name: "_Ca5 WH A" })
    .select()
    .single();
  const { data: whB } = await admin
    .from("warehouses")
    .insert({ organization_id: orgB.id, code: "_CA5_WH_B", name: "_Ca5 WH B" })
    .select()
    .single();

  const { data: ordA } = await admin
    .from("orders")
    .insert({ organization_id: orgA.id, waybill_code: "_CA5_ORD_A" })
    .select()
    .single();
  const { data: ordB } = await admin
    .from("orders")
    .insert({ organization_id: orgB.id, waybill_code: "_CA5_ORD_B" })
    .select()
    .single();

  const { data: camA } = await admin
    .from("cameras")
    .insert({
      organization_id: orgA.id,
      name: "_Ca5 Cam A",
      camera_code: "_CA5_CAM_A",
      ip: "10.0.0.101",
    })
    .select()
    .single();
  const { data: camB } = await admin
    .from("cameras")
    .insert({
      organization_id: orgB.id,
      name: "_Ca5 Cam B",
      camera_code: "_CA5_CAM_B",
      ip: "10.0.0.102",
    })
    .select()
    .single();

  if (!whA || !whB || !ordA || !ordB || !camA || !camB) throw new Error("Seed data fail");

  console.log(`  ${C.gray}Org A: ${orgA.id}  Org B: ${orgB.id}${C.reset}`);
  console.log(
    `  ${C.gray}Warehouses A=${whA.id} B=${whB.id}${C.reset}`,
  );
  console.log(`  ${C.gray}Orders A=${ordA.id} B=${ordB.id}${C.reset}`);
  console.log(`  ${C.gray}Cameras A=${camA.id} B=${camB.id}${C.reset}`);

  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    warehouseAId: whA.id,
    warehouseBId: whB.id,
    orderAId: ordA.id,
    orderBId: ordB.id,
    cameraAId: camA.id,
    cameraBId: camB.id,
  };
}

async function cleanup(ctx: SeedCtx | null): Promise<void> {
  if (!ctx) return;
  console.log(`\n${C.cyan}━━━ CLEANUP seed${C.reset}`);
  for (const orgId of [ctx.orgAId, ctx.orgBId].filter(Boolean)) {
    for (const t of ["order_proof_clips", "packing_events", "cameras", "orders", "warehouses"]) {
      await admin.from(t).delete().eq("organization_id", orgId);
    }
    await admin.from("organizations").delete().eq("id", orgId);
  }
  console.log(`  ${C.gray}Seed 2 org đã xóa${C.reset}`);
}

// ============================================================================
// MFA login
// ============================================================================
async function loginWithMfa(): Promise<{
  accessToken: string;
  cookieHeader: string;
}> {
  const password = await askPassword(`Password của ${PLATFORM_EMAIL}: `);
  if (password.length < 8) throw new Error("Password quá ngắn");

  console.log(`\n${C.gray}[1] signInWithPassword...${C.reset}`);
  const client = createClient(SUPA_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signInErr } = await client.auth.signInWithPassword({
    email: PLATFORM_EMAIL,
    password,
  });
  if (signInErr || !signIn.session) throw new Error(`signIn: ${signInErr?.message}`);
  console.log(`  ${C.green}✓${C.reset} session AAL1`);

  console.log(`\n${C.gray}[2] MFA challenge + verify...${C.reset}`);
  const { data: factors } = await client.auth.mfa.listFactors();
  const totp = factors?.totp?.find((f) => f.status === "verified");
  if (!totp) throw new Error("Không tìm thấy TOTP factor verified");

  const { data: challenge, error: chErr } = await client.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (chErr || !challenge) throw new Error(`challenge: ${chErr?.message}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await askOtp(`  Nhập OTP 6-digit (${attempt}/3): `);
    if (!/^\d{6}$/.test(code)) {
      console.log(`  ${C.yellow}✗ Không phải 6-digit${C.reset}`);
      continue;
    }
    const { error: vErr } = await client.auth.mfa.verify({
      factorId: totp.id,
      challengeId: challenge.id,
      code,
    });
    if (vErr) {
      console.log(`  ${C.yellow}✗ ${vErr.message}${C.reset}`);
      continue;
    }
    console.log(`  ${C.green}✓${C.reset} MFA verified, AAL2`);
    break;
  }

  const { data: sessionData } = await client.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  const refreshToken = sessionData.session?.refresh_token;
  const expiresAt = sessionData.session?.expires_at;
  if (!accessToken) throw new Error("Không lấy được access_token sau MFA");

  const projectRef = new URL(SUPA_URL).hostname.split(".")[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const cookieValue = encodeURIComponent(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken ?? "fake",
      expires_at: expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: "bearer",
    }),
  );
  return { accessToken, cookieHeader: `${cookieName}=${cookieValue}` };
}

// ============================================================================
// TEST CA 1 (Happy) — impersonate org A → thấy data org A
// TEST CA 2 (NỬA-ÂM — trọng tâm) — impersonate org A → thấy A, 0 row B
// TEST CA 3 (Expired) — token -6 phút → 401
// ============================================================================
async function testHappyAndNegative(
  ctx: SeedCtx,
  cookieHeader: string,
): Promise<{ happy: boolean; negative: boolean }> {
  // Impersonate org A qua COOKIE-CARRIER đúng flow (không self-sign, không
  // gửi x-internal-*).
  //
  // Proxy khối 1 STRIP mọi header x-internal-* client gửi (design đúng —
  // client không được set signed header). Script phải set cookie
  // impersonate_org_id → proxy khối 2 gate platform-admin → ký token →
  // forward vào request → guard verify. Đây flow thật app dùng.
  const impersonateCookie = `impersonate_org_id=${ctx.orgAId}`;
  const fullCookie = `${cookieHeader}; ${impersonateCookie}`;

  const endpoints = [
    { path: "/api/warehouses", key: "warehouses", idA: ctx.warehouseAId, idB: ctx.warehouseBId },
    { path: "/api/cameras", key: "cameras", idA: ctx.cameraAId, idB: ctx.cameraBId },
  ];

  let happyOk = true;
  let negOk = true;

  for (const ep of endpoints) {
    console.log(`\n  ${C.cyan}→ ${ep.path}${C.reset} (impersonate org A qua cookie)`);
    const res = await fetch(`${APP_URL}${ep.path}`, {
      headers: { cookie: fullCookie },
      redirect: "manual",
    });
    const bodyText = await res.text();
    console.log(`    status=${res.status}`);

    if (res.status !== 200) {
      console.log(
        `    ${C.red}✗${C.reset} endpoint không trả 200, body: ${bodyText.slice(0, 200)}`,
      );
      happyOk = false;
      continue;
    }

    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      console.log(
        `    ${C.yellow}⚠${C.reset} body không JSON: ${bodyText.slice(0, 200)}`,
      );
      continue;
    }

    // Extract id list — endpoint có thể trả { warehouses: [...] } hoặc [...]
    let items: Array<{ id?: string }> = [];
    if (Array.isArray(bodyJson)) items = bodyJson;
    else if (bodyJson && typeof bodyJson === "object") {
      const record = bodyJson as Record<string, unknown>;
      // Try common keys
      for (const k of [ep.key, "data", "items", "rows"]) {
        if (Array.isArray(record[k])) {
          items = record[k] as Array<{ id?: string }>;
          break;
        }
      }
    }

    const ids = items.map((it) => it.id).filter(Boolean) as string[];
    console.log(
      `    ${C.gray}items=${items.length}, first ids=[${ids.slice(0, 3).join(", ")}]${C.reset}`,
    );

    // Nửa-dương: id-A phải xuất hiện
    const seesA = ids.includes(ep.idA);
    // Nửa-âm (TRỌNG TÂM): id-B KHÔNG được xuất hiện
    const seesB = ids.includes(ep.idB);

    if (seesA) {
      console.log(
        `    ${C.green}✓${C.reset} NỬA-DƯƠNG: thấy id-A (${ep.idA.slice(0, 8)}...) — platform vào được org A`,
      );
    } else {
      console.log(
        `    ${C.red}✗${C.reset} NỬA-DƯƠNG SAI: KHÔNG thấy id-A — platform không vào được org A`,
      );
      happyOk = false;
    }

    if (!seesB) {
      console.log(
        `    ${C.green}✓${C.reset} NỬA-ÂM: KHÔNG thấy id-B — platform giới hạn org-token`,
      );
    } else {
      console.log(
        `    ${C.red}✗ LEAK NỬA-ÂM${C.reset}: platform impersonate A THẤY id-B (${ep.idB.slice(0, 8)}...) — is_platform_admin() BYPASS QUÁ TAY, thấy all thay vì org-token`,
      );
      negOk = false;
    }
  }

  return { happy: happyOk, negative: negOk };
}

async function testExpired(ctx: SeedCtx): Promise<boolean> {
  // Test expired ở LỚP C (verifyOrgContext) trực tiếp, không qua HTTP.
  //
  // Lý do không qua HTTP: proxy khối 1 strip x-internal-* client gửi (design
  // đúng, chặn client set signed header). Proxy khối 2 với cookie impersonate
  // luôn ký token TTL 5 phút MỚI → không thể inject expired qua HTTP flow.
  //
  // Test lớp C trực tiếp verify đúng ca: sign token -6 phút → verifyOrgContext
  // trả reason='expired'. Đây là logic mà guard.ts:118-132 dựa để trả 401
  // org_context_expired. Verify lớp C xanh = tin tưởng guard trả 401 đúng
  // khi lớp C báo expired.
  console.log(`\n  ${C.cyan}→ verifyOrgContext (lớp C) — token -6 phút${C.reset}`);
  const expiredToken = await signOrgContext({
    orgId: ctx.orgAId,
    timestamp: Date.now() - 6 * 60 * 1000,
    nonce: crypto.randomUUID(),
  });
  const result = await verifyOrgContext(expiredToken);
  console.log(`    valid=${result.valid}, reason=${(result as { reason?: string }).reason ?? "(n/a)"}`);
  const ok = !result.valid && (result as { reason?: string }).reason === "expired";
  if (ok) {
    console.log(
      `    ${C.green}✓${C.reset} EXPIRED: verifyOrgContext trả reason='expired' → guard sẽ trả 401 org_context_expired`,
    );
  } else {
    console.log(
      `    ${C.red}✗${C.reset} EXPIRED SAI: mong valid=false + reason='expired', nhận valid=${result.valid} reason=${(result as { reason?: string }).reason}`,
    );
  }
  return ok;
}

// ============================================================================
// MAIN
// ============================================================================
async function main(): Promise<void> {
  console.log(`${C.cyan}${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.cyan}${C.bold}  Ca 5 — Platform impersonate (cookie-carrier)${C.reset}`);
  console.log(`  Platform admin: ${PLATFORM_EMAIL}`);
  console.log(`  Trọng tâm: NỬA-ÂM (impersonate A → 0 row B)`);
  console.log(`${C.cyan}${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);

  let ctx: SeedCtx | null = null;
  let exitCode = 0;

  try {
    await cleanupExistingSeed();
    ctx = await seed();

    const { cookieHeader } = await loginWithMfa();

    console.log(
      `\n${C.cyan}${C.bold}━━━ CA 1+2 — Happy (nửa-dương) + NỬA-ÂM (trọng tâm)${C.reset}`,
    );
    const { happy, negative } = await testHappyAndNegative(ctx, cookieHeader);

    console.log(`\n${C.cyan}${C.bold}━━━ CA 3 — Expired token (lớp C direct)${C.reset}`);
    const expired = await testExpired(ctx);

    // ═══════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`\n${C.cyan}${C.bold}━━━ KẾT QUẢ CA 5${C.reset}`);
    console.log(`  Happy (nửa-dương): ${happy ? C.green + "PASS" : C.red + "FAIL"}${C.reset}`);
    console.log(
      `  ${C.bold}NỬA-ÂM platform-token${C.reset}: ${negative ? C.green + "PASS" : C.red + "FAIL"}${C.reset} ${negative ? C.gray + "(đóng UNVERIFIED Gate 2)" + C.reset : ""}`,
    );
    console.log(`  Expired: ${expired ? C.green + "PASS" : C.red + "FAIL"}${C.reset}`);

    if (happy && negative && expired) {
      console.log(
        `\n${C.green}${C.bold}CA 5 XANH — Platform impersonate + nửa-âm + expired verified. UNVERIFIED Gate 2 đóng.${C.reset}`,
      );
      exitCode = 0;
    } else {
      console.log(
        `\n${C.red}${C.bold}CA 5 ĐỎ — có ca fail. Review log, sửa RLS/guard.${C.reset}`,
      );
      exitCode = 1;
    }
  } catch (e) {
    console.error(`\n${C.red}${C.bold}FATAL:${C.reset}`, e);
    exitCode = 3;
  } finally {
    try {
      await cleanup(ctx);
    } catch (e) {
      console.error(`${C.red}Cleanup lỗi:${C.reset}`, e);
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(4);
});
