/**
 * Safe Retry E2E verify — 4 case bằng SQL simulation (không cần agent thật).
 *
 * Chạy: node --experimental-strip-types --env-file=.env.local scripts/verify-safe-retry.ts
 *
 * Verify các case:
 *   1. Retry thành công: có ready cũ → tạo pending mới → simulate promote →
 *      ready cũ superseded, pending mới ready. Bucket cũ giữ nguyên (chỉ
 *      test tồn tại row/path — không thao tác storage thật).
 *   2. Retry thất bại: có ready cũ → tạo pending mới → simulate failed →
 *      pending mới → failed. Ready cũ KHÔNG bị đổi.
 *   3. Idempotent callback: promote 2 lần với cùng args → lần 2 trả
 *      'already_promoted', không đổi trạng thái.
 *   4. Reuse pending guard: có pending → gọi enqueue lần 2 với replaces
 *      khác → phải raise 'enqueue_pending_replaces_mismatch'.
 *
 * Setup: seed pe_id sạch (không có clip nào), chạy 4 case, cleanup mỗi case.
 */

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !SERVICE) {
  console.error(
    "Missing SUPABASE env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
  );
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
};

let passed = 0;
let failed = 0;

function ok(label: string, detail?: string) {
  console.log(`${C.green}✓${C.reset} ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
}
function bad(label: string, detail?: string) {
  console.log(`${C.red}✗${C.reset} ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}
function head(label: string) {
  console.log(`\n${C.cyan}=== ${label} ===${C.reset}`);
}

/** Tìm 1 pe không có clip nào (sạch), để test isolation. */
async function findCleanPe(): Promise<{
  pe_id: string;
  camera_id: string;
} | null> {
  const { data } = await admin
    .from("packing_events")
    .select("id, proof_camera_id")
    .eq("organization_id", BETACOM_ORG_ID)
    .not("proof_camera_id", "is", null)
    .limit(20);
  if (!data) return null;
  for (const pe of data) {
    const { data: existing } = await admin
      .from("order_proof_clips")
      .select("id")
      .eq("packing_event_id", pe.id)
      .limit(1);
    if (!existing || existing.length === 0) {
      return {
        pe_id: pe.id as string,
        camera_id: pe.proof_camera_id as string,
      };
    }
  }
  return null;
}

async function cleanup(peId: string) {
  const { data: clips } = await admin
    .from("order_proof_clips")
    .select("id")
    .eq("packing_event_id", peId);
  const clipIds = (clips ?? []).map((c) => c.id as string);
  if (clipIds.length > 0) {
    await admin
      .from("agent_commands")
      .delete()
      .eq("type", "cut_clip")
      .in(
        "payload->>clip_id",
        clipIds,
      );
    await admin.from("order_proof_clips").delete().in("id", clipIds);
  }
}

async function seedReady(
  peId: string,
  cameraId: string,
  bucketPath: string,
): Promise<string> {
  const { data, error } = await admin
    .from("order_proof_clips")
    .insert({
      organization_id: BETACOM_ORG_ID,
      packing_event_id: peId,
      camera_id: cameraId,
      waybill_code: "SAFE_RETRY_E2E",
      status: "ready",
      bucket_path: bucketPath,
      bucket_uploaded_at: new Date().toISOString(),
      generated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedReady: ${error?.message}`);
  return data.id as string;
}

async function seedPending(
  peId: string,
  cameraId: string,
  replacesClipId: string | null,
): Promise<string> {
  const { data, error } = await admin
    .from("order_proof_clips")
    .insert({
      organization_id: BETACOM_ORG_ID,
      packing_event_id: peId,
      camera_id: cameraId,
      waybill_code: "SAFE_RETRY_E2E",
      status: "pending",
      cut_mode: "copy",
      generation_params: {
        replaces_clip_id: replacesClipId,
      },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedPending: ${error?.message}`);
  return data.id as string;
}

async function callPromote(
  newClipId: string,
  peId: string,
  bucketPath: string,
  oldClipId: string | null,
): Promise<{ result: string | null; error: string | null }> {
  const { data, error } = await admin.rpc("promote_clip_generation", {
    p_new_clip_id: newClipId,
    p_packing_event_id: peId,
    p_bucket_path: bucketPath,
    p_old_clip_id: oldClipId,
  });
  return {
    result: typeof data === "string" ? data : null,
    error: error?.message ?? null,
  };
}

async function readStatus(clipId: string): Promise<string | null> {
  const { data } = await admin
    .from("order_proof_clips")
    .select("status")
    .eq("id", clipId)
    .maybeSingle();
  return (data?.status as string) ?? null;
}

async function testCase1_RetrySuccess(pe: { pe_id: string; camera_id: string }) {
  head("Case 1: Retry thành công (flip đôi)");
  const oldBucket = `${BETACOM_ORG_ID}/${pe.pe_id}/old.mp4`;
  const newBucket = `${BETACOM_ORG_ID}/${pe.pe_id}/new.mp4`;

  const oldId = await seedReady(pe.pe_id, pe.camera_id, oldBucket);
  const newId = await seedPending(pe.pe_id, pe.camera_id, oldId);

  const promote = await callPromote(newId, pe.pe_id, newBucket, oldId);
  if (promote.result === "promoted_retry") {
    ok("Promote trả 'promoted_retry'");
  } else {
    bad("Promote không trả 'promoted_retry'", `${promote.result} / ${promote.error}`);
  }

  const oldStatus = await readStatus(oldId);
  const newStatus = await readStatus(newId);
  if (oldStatus === "superseded") ok("Row cũ chuyển 'superseded'");
  else bad("Row cũ không superseded", `status=${oldStatus}`);
  if (newStatus === "ready") ok("Row mới chuyển 'ready'");
  else bad("Row mới không ready", `status=${newStatus}`);

  await cleanup(pe.pe_id);
}

async function testCase2_RetryFailedKeepsOld(pe: {
  pe_id: string;
  camera_id: string;
}) {
  head("Case 2: Retry thất bại — clip ready cũ giữ nguyên");
  const oldBucket = `${BETACOM_ORG_ID}/${pe.pe_id}/old.mp4`;

  const oldId = await seedReady(pe.pe_id, pe.camera_id, oldBucket);
  const newId = await seedPending(pe.pe_id, pe.camera_id, oldId);

  // Simulate cut fail: mark pending → failed (như clip-cut-result outcome=failed)
  await admin
    .from("order_proof_clips")
    .update({ status: "failed", error_message: "simulated_cut_failed" })
    .eq("id", newId);

  const oldStatus = await readStatus(oldId);
  const newStatus = await readStatus(newId);
  if (oldStatus === "ready") ok("Row ready cũ vẫn 'ready'");
  else bad("Row ready cũ bị đổi", `status=${oldStatus}`);
  if (newStatus === "failed") ok("Row pending mới chuyển 'failed'");
  else bad("Row pending mới không failed", `status=${newStatus}`);

  await cleanup(pe.pe_id);
}

async function testCase3_IdempotentReplay(pe: {
  pe_id: string;
  camera_id: string;
}) {
  head("Case 3: Idempotent callback replay");
  const bucket = `${BETACOM_ORG_ID}/${pe.pe_id}/first.mp4`;
  const newId = await seedPending(pe.pe_id, pe.camera_id, null);

  const first = await callPromote(newId, pe.pe_id, bucket, null);
  const second = await callPromote(newId, pe.pe_id, bucket, null);

  if (first.result === "promoted_first") ok("Lần 1 trả 'promoted_first'");
  else bad("Lần 1 không first", `${first.result} / ${first.error}`);
  if (second.result === "already_promoted") ok("Lần 2 trả 'already_promoted'");
  else bad("Lần 2 không idempotent", `${second.result} / ${second.error}`);

  await cleanup(pe.pe_id);
}

async function testCase4_ReusePendingReplacesMismatch(pe: {
  pe_id: string;
  camera_id: string;
}) {
  head("Case 4: Reuse pending guard — replaces_clip_id mismatch");
  const { data: agent } = await admin
    .from("warehouse_agents")
    .select("id")
    .eq("organization_id", BETACOM_ORG_ID)
    .limit(1)
    .single();
  if (!agent) {
    bad("Không tìm được agent", "cannot run test");
    return;
  }

  const fakeReplacesA = randomUUID();
  const fakeReplacesB = randomUUID();

  // Enqueue 1: replaces = A
  const { data: r1, error: e1 } = await admin
    .rpc("enqueue_clip_generation", {
      p_organization_id: BETACOM_ORG_ID,
      p_packing_event_id: pe.pe_id,
      p_camera_id: pe.camera_id,
      p_waybill_code: "SAFE_RETRY_E2E",
      p_agent_id: agent.id,
      p_clip_started_at: new Date().toISOString(),
      p_clip_ended_at: new Date(Date.now() + 10_000).toISOString(),
      p_is_partial: false,
      p_source_files: [],
      p_generation_params: {},
      p_command_payload: { replaces_clip_id: fakeReplacesA },
    })
    .single<{ clip_id: string; command_id: string; result_status: string }>();
  if (e1 || !r1) {
    bad("Enqueue 1 fail", e1?.message ?? "unknown");
    return;
  }
  if (r1.result_status !== "created") bad("Enqueue 1 không 'created'", r1.result_status);
  else ok("Enqueue 1 tạo mới OK");

  // Enqueue 2: replaces = B (khác A) → phải raise mismatch
  const { error: e2 } = await admin.rpc("enqueue_clip_generation", {
    p_organization_id: BETACOM_ORG_ID,
    p_packing_event_id: pe.pe_id,
    p_camera_id: pe.camera_id,
    p_waybill_code: "SAFE_RETRY_E2E",
    p_agent_id: agent.id,
    p_clip_started_at: new Date().toISOString(),
    p_clip_ended_at: new Date(Date.now() + 10_000).toISOString(),
    p_is_partial: false,
    p_source_files: [],
    p_generation_params: {},
    p_command_payload: { replaces_clip_id: fakeReplacesB },
  });
  if (e2 && e2.message.includes("enqueue_pending_replaces_mismatch")) {
    ok("Enqueue 2 raise 'enqueue_pending_replaces_mismatch'");
  } else {
    bad(
      "Enqueue 2 không raise đúng",
      e2?.message ?? "returned success (bug!)",
    );
  }

  await cleanup(pe.pe_id);
}

async function main() {
  console.log(`${C.yellow}Safe Retry E2E verify (SQL simulation)${C.reset}\n`);

  const pe = await findCleanPe();
  if (!pe) {
    console.error(`${C.red}No clean packing_event found — cannot run.${C.reset}`);
    process.exit(2);
  }
  console.log(
    `Using pe_id=${pe.pe_id} camera_id=${pe.camera_id}\n`,
  );

  try {
    await cleanup(pe.pe_id);
    await testCase1_RetrySuccess(pe);
    await testCase2_RetryFailedKeepsOld(pe);
    await testCase3_IdempotentReplay(pe);
    await testCase4_ReusePendingReplacesMismatch(pe);
  } finally {
    await cleanup(pe.pe_id);
  }

  console.log(
    `\n${C.cyan}Result: ${passed} passed, ${failed} failed${C.reset}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(2);
});
