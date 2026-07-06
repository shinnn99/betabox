/**
 * N2 DiD-A verify — cross-tenant video signed URL, 3 nửa.
 *
 * Chạy: node --experimental-strip-types --env-file=.env.local scripts/verify-n2-cross-tenant.ts
 *
 * Tại sao viết riêng: verify-rls-cross-tenant.ts đóng Gate 2 row-level (PostgREST
 * scoped-by-org). N2 DiD-A đóng storage-level — helper
 * createProofClipSignedUrlBy{PackingEvent,ClipId} verify org bên trong. Row-level
 * xanh KHÔNG bảo chứng storage-level xanh: nếu route quên verify org và truyền
 * bucketPath trần cho createSignedUrl, service_role sẽ cấp URL kể cả với clip
 * org khác. Helper mới chặn bằng cách verify TRONG helper. Verify N2 = chạy chính
 * helper đó với ctx sai org, phải trả `cross_org`.
 *
 * Ba nửa:
 *   1. NỬA DƯƠNG      — ctx Betacom + clipId Betacom → ok=true, signedUrl có.
 *   2. NỬA ÂM ROW      — ctx throwaway + peId Betacom → không tìm thấy row hoặc cross_org.
 *   3. NỬA ÂM STORAGE  — ctx throwaway + clipId Betacom → cross_org (không cấp URL).
 *
 * Seed org throwaway + packing_event + clip Betacom-thật với bucket_path fake để
 * chạy nhánh signIfBucketValid. KHÔNG upload file thật — chỉ test logic verify org.
 *
 * Cleanup: xóa toàn bộ dấu vết throwaway kể cả khi test fail.
 */

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  createProofClipSignedUrlByPackingEvent,
  createProofClipSignedUrlByClipId,
} from "../src/lib/watch/proof-clip-signed-url.ts";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !SERVICE) {
  console.error("Missing SUPABASE env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(2);
}

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BETACOM_ORG_ID = "00000000-0000-0000-0000-000000000001";

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

let failed = 0;
function pass(label: string, detail: string) {
  console.log(`${C.green}✓ PASS${C.reset} ${C.bold}${label}${C.reset} — ${detail}`);
}
function fail(label: string, detail: string) {
  failed++;
  console.log(`${C.red}✗ FAIL${C.reset} ${C.bold}${label}${C.reset} — ${detail}`);
}

// ------------- Guard: DB chỉ có Betacom trước khi seed -------------
{
  const { data: orgs } = await admin.from("organizations").select("id, name");
  if (!orgs || orgs.length !== 1 || orgs[0].id !== BETACOM_ORG_ID) {
    console.error(
      `${C.red}Guard fail: DB có ${orgs?.length ?? 0} org, mong đợi đúng 1 (Betacom). Dừng.${C.reset}`,
    );
    console.error("Orgs:", orgs);
    process.exit(2);
  }
  console.log(`${C.cyan}Guard OK: DB có 1 org Betacom.${C.reset}`);
}

// ------------- Lấy 1 clip Betacom-thật có bucket_path (nếu không có thì tạm-seed) -------------
let betacomClipId: string | null = null;
let betacomPeId: string | null = null;
let seededFakeClip = false;

{
  const { data } = await admin
    .from("order_proof_clips")
    .select("id, packing_event_id, bucket_path, bucket_uploaded_at, status")
    .eq("organization_id", BETACOM_ORG_ID)
    .eq("status", "ready")
    .not("bucket_path", "is", null)
    .not("bucket_uploaded_at", "is", null)
    .limit(1);
  if (data && data.length > 0) {
    betacomClipId = data[0].id;
    betacomPeId = data[0].packing_event_id;
    console.log(
      `${C.cyan}Dùng clip Betacom thật id=${betacomClipId} pe=${betacomPeId} (không seed fake).${C.reset}`,
    );
  } else {
    // Không có clip ready+bucket → seed 1 clip Betacom-fake để chạy nhánh.
    // Tạo tạm cả packing_event kèm theo — sẽ xóa sạch.
    const { data: cam } = await admin
      .from("cameras")
      .select("id")
      .eq("organization_id", BETACOM_ORG_ID)
      .limit(1);
    const { data: wh } = await admin
      .from("warehouses")
      .select("id")
      .eq("organization_id", BETACOM_ORG_ID)
      .limit(1);
    if (!cam?.[0] || !wh?.[0]) {
      console.error("Betacom không có camera/warehouse — cần dữ liệu tối thiểu để seed clip fake.");
      process.exit(2);
    }
    const rawEventId = randomUUID();
    const peId = randomUUID();
    // packing_events cần raw_event_id → seed row scanner_events trước (schema thực tế đơn giản hoá).
    // Cách rẻ hơn: dùng packing_event có sẵn của Betacom.
    const { data: pes } = await admin
      .from("packing_events")
      .select("id")
      .eq("organization_id", BETACOM_ORG_ID)
      .limit(1);
    if (!pes?.[0]) {
      console.error("Betacom không có packing_event — chưa đủ dữ liệu để verify.");
      process.exit(2);
    }
    betacomPeId = pes[0].id;
    const { data: ins, error } = await admin
      .from("order_proof_clips")
      .insert({
        organization_id: BETACOM_ORG_ID,
        packing_event_id: betacomPeId,
        waybill_code: "N2-VERIFY-FAKE",
        camera_id: cam[0].id,
        status: "ready",
        bucket_path: `${BETACOM_ORG_ID}/${betacomPeId}.mp4`,
        bucket_uploaded_at: new Date().toISOString(),
        cut_mode: "copy",
      })
      .select("id")
      .single();
    if (error || !ins) {
      console.error("Seed clip fake fail:", error?.message);
      process.exit(2);
    }
    betacomClipId = ins.id;
    seededFakeClip = true;
    console.log(
      `${C.yellow}Seed clip Betacom-fake id=${betacomClipId} pe=${betacomPeId} (sẽ xóa cuối).${C.reset}`,
    );
  }
}

// ------------- Seed org throwaway -------------
const throwawayOrgId = randomUUID();
{
  const { error } = await admin
    .from("organizations")
    .insert({
      id: throwawayOrgId,
      name: "N2 Verify Throwaway",
      slug: `n2-verify-${throwawayOrgId.slice(0, 8)}`,
    });
  if (error) {
    console.error("Seed org throwaway fail:", error.message);
    process.exit(2);
  }
  console.log(`${C.cyan}Seed org throwaway id=${throwawayOrgId}.${C.reset}`);
}

// ============================================================================
// Run 3 nửa
// ============================================================================

async function runVerification() {
  // NỬA 1 — DƯƠNG: ctx Betacom + peId Betacom → ok=true
  {
    const r = await createProofClipSignedUrlByPackingEvent(
      { organizationId: BETACOM_ORG_ID },
      betacomPeId!,
    );
    if (r.ok) {
      const urlPreview = r.signedUrl.slice(0, 80) + "...";
      pass(
        "NỬA 1 (dương) byPackingEvent",
        `ctx=Betacom pe=Betacom → ok=true, signedUrl=${urlPreview}`,
      );
    } else if (r.reason === "signed_url_failed") {
      // Bucket path fake không tồn tại → signed URL vẫn cấp được (Supabase
      // không check tồn tại trước khi sign). Nếu bucket path thật không có
      // file, GET URL sẽ 404, nhưng CREATE URL vẫn ok. Nếu fail ở đây =
      // config bucket sai, không phải lỗi cross-tenant. Log warning.
      fail(
        "NỬA 1 (dương) byPackingEvent",
        `ctx=Betacom pe=Betacom nhưng signed URL fail: ${r.message ?? "unknown"}. Bucket 'proof-clips-transient' đã tạo chưa?`,
      );
    } else {
      fail(
        "NỬA 1 (dương) byPackingEvent",
        `ctx=Betacom pe=Betacom mong ok=true, thực nhận reason=${r.reason}`,
      );
    }
  }

  // NỬA 1b — DƯƠNG byClipId
  {
    const r = await createProofClipSignedUrlByClipId(
      { organizationId: BETACOM_ORG_ID },
      betacomClipId!,
    );
    if (r.ok) {
      pass("NỬA 1b (dương) byClipId", `ctx=Betacom clip=Betacom → ok=true`);
    } else if (r.reason === "signed_url_failed") {
      fail(
        "NỬA 1b (dương) byClipId",
        `signed URL fail: ${r.message ?? "unknown"} — bucket config?`,
      );
    } else {
      fail(
        "NỬA 1b (dương) byClipId",
        `mong ok=true, thực nhận reason=${r.reason}`,
      );
    }
  }

  // NỬA 2 — ÂM: ctx throwaway + peId Betacom → cross_org
  {
    const r = await createProofClipSignedUrlByPackingEvent(
      { organizationId: throwawayOrgId },
      betacomPeId!,
    );
    if (!r.ok && r.reason === "cross_org") {
      pass(
        "NỬA 2 (âm) byPackingEvent",
        `ctx=throwaway pe=Betacom → cross_org (KHÔNG cấp URL)`,
      );
    } else if (r.ok) {
      fail(
        "NỬA 2 (âm) byPackingEvent",
        `LEAK: ctx=throwaway pe=Betacom vẫn cấp signed URL! signedUrl=${r.signedUrl.slice(0, 60)}...`,
      );
    } else {
      fail(
        "NỬA 2 (âm) byPackingEvent",
        `mong cross_org, thực nhận reason=${r.reason}`,
      );
    }
  }

  // NỬA 3 — ÂM: ctx throwaway + clipId Betacom → cross_org
  {
    const r = await createProofClipSignedUrlByClipId(
      { organizationId: throwawayOrgId },
      betacomClipId!,
    );
    if (!r.ok && r.reason === "cross_org") {
      pass(
        "NỬA 3 (âm) byClipId",
        `ctx=throwaway clip=Betacom → cross_org (KHÔNG cấp URL)`,
      );
    } else if (r.ok) {
      fail(
        "NỬA 3 (âm) byClipId",
        `LEAK: ctx=throwaway clip=Betacom vẫn cấp URL! signedUrl=${r.signedUrl.slice(0, 60)}...`,
      );
    } else {
      fail(
        "NỬA 3 (âm) byClipId",
        `mong cross_org, thực nhận reason=${r.reason}`,
      );
    }
  }
}

let runErr: unknown = null;
try {
  await runVerification();
} catch (e) {
  runErr = e;
  console.error(`${C.red}Run threw:${C.reset}`, e);
}

// ============================================================================
// Cleanup — ALWAYS chạy, kể cả khi test fail
// ============================================================================
console.log(`\n${C.cyan}Cleanup…${C.reset}`);
if (seededFakeClip && betacomClipId) {
  const { error } = await admin
    .from("order_proof_clips")
    .delete()
    .eq("id", betacomClipId);
  if (error) console.error(`Cleanup clip fake fail: ${error.message}`);
  else console.log(`  Xóa clip fake ${betacomClipId} — OK`);
}
{
  const { error } = await admin
    .from("organizations")
    .delete()
    .eq("id", throwawayOrgId);
  if (error) console.error(`Cleanup org throwaway fail: ${error.message}`);
  else console.log(`  Xóa org throwaway ${throwawayOrgId} — OK`);
}

// Verify cleanup sạch
{
  const { data } = await admin.from("organizations").select("id");
  if (!data || data.length !== 1 || data[0].id !== BETACOM_ORG_ID) {
    console.error(
      `${C.red}Cleanup KHÔNG SẠCH: còn ${data?.length ?? 0} org sau cleanup.${C.reset}`,
      data,
    );
    process.exit(3);
  }
  console.log(`${C.cyan}Cleanup OK: DB về 1 org Betacom.${C.reset}`);
}

if (runErr) {
  console.error(`${C.red}Verify aborted do exception.${C.reset}`);
  process.exit(2);
}

if (failed > 0) {
  console.log(`\n${C.red}${C.bold}N2 VERIFY FAIL: ${failed} nửa fail.${C.reset}`);
  process.exit(1);
}
console.log(`\n${C.green}${C.bold}N2 DiD-A verify: 4/4 nửa PASS.${C.reset}`);
