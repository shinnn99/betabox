import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent báo kết quả cắt clip.
 *
 * Safe-retry S5 2026-07-06:
 *   - Update theo `clip_id` (identity generation), KHÔNG upsert theo pe_id.
 *   - Row `order_proof_clips` được pre-insert ở enqueue (H4 RPC atomic);
 *     endpoint này CHỈ UPDATE, KHÔNG INSERT/DELETE.
 *   - `bucket_path` KHÔNG set ở đây — chỉ set qua RPC `promote_clip_generation`
 *     tại endpoint `clip-upload-complete` (S6).
 *
 * Outcome map:
 *   'encoding' — cập nhật `progress_state='encoding'` (status vẫn 'pending').
 *   'done'     — cập nhật clip metadata (duration, size, generation_params).
 *                KHÔNG chuyển status='ready' ở đây; ready = promote qua RPC.
 *                Agent gọi outcome='done' TRƯỚC khi upload complete (sau
 *                khi cắt+probe xong) → row có metadata nhưng status vẫn
 *                pending, chờ promote.
 *   'failed'   — cập nhật `status='failed'` + `error_message`. Row vẫn
 *                giữ (superseded nếu retry sau).
 *
 * Cross-tenant guard: clip phải thuộc org của agent.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Outcome = "done" | "failed" | "encoding";

interface ResultBody {
  clip_id: string;
  packing_event_id: string;
  camera_id: string;
  waybill_code: string;
  outcome: Outcome;
  clip_path: string | null;
  clip_name: string | null;
  clip_started_at: string | null;
  clip_ended_at: string | null;
  duration_seconds: number | null;
  duration_drift_seconds: number | null;
  file_size_bytes: number | null;
  is_partial: boolean;
  covered_range_lower: string | null;
  covered_range_upper: string | null;
  source_files: string[];
  error_message: string | null;
  generation_params: Record<string, unknown>;
}

type ParseOutcome = { ok: true; body: ResultBody } | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const clipId = typeof r.clip_id === "string" ? r.clip_id.trim() : "";
  if (!UUID_RE.test(clipId)) return { ok: false, error: "clip_id_invalid" };

  const packingEventId = typeof r.packing_event_id === "string" ? r.packing_event_id.trim() : "";
  if (!UUID_RE.test(packingEventId)) return { ok: false, error: "packing_event_id_invalid" };

  const cameraId = typeof r.camera_id === "string" ? r.camera_id.trim() : "";
  if (!UUID_RE.test(cameraId)) return { ok: false, error: "camera_id_invalid" };

  const waybillCode = typeof r.waybill_code === "string" ? r.waybill_code.trim() : "";
  if (!waybillCode) return { ok: false, error: "waybill_code_required" };

  const outcomeRaw = typeof r.outcome === "string" ? r.outcome.trim() : "";
  if (outcomeRaw !== "done" && outcomeRaw !== "failed" && outcomeRaw !== "encoding") {
    return { ok: false, error: "outcome_invalid" };
  }

  return {
    ok: true,
    body: {
      clip_id: clipId,
      packing_event_id: packingEventId,
      camera_id: cameraId,
      waybill_code: waybillCode,
      outcome: outcomeRaw,
      clip_path: typeof r.clip_path === "string" ? r.clip_path : null,
      clip_name: typeof r.clip_name === "string" ? r.clip_name : null,
      clip_started_at: typeof r.clip_started_at === "string" ? r.clip_started_at : null,
      clip_ended_at: typeof r.clip_ended_at === "string" ? r.clip_ended_at : null,
      duration_seconds:
        typeof r.duration_seconds === "number" && Number.isFinite(r.duration_seconds)
          ? Math.round(r.duration_seconds)
          : null,
      duration_drift_seconds:
        typeof r.duration_drift_seconds === "number" && Number.isFinite(r.duration_drift_seconds)
          ? Number(r.duration_drift_seconds.toFixed(3))
          : null,
      file_size_bytes:
        typeof r.file_size_bytes === "number" && Number.isFinite(r.file_size_bytes)
          ? Math.round(r.file_size_bytes)
          : null,
      is_partial: r.is_partial === true,
      covered_range_lower:
        typeof r.covered_range_lower === "string" ? r.covered_range_lower : null,
      covered_range_upper:
        typeof r.covered_range_upper === "string" ? r.covered_range_upper : null,
      source_files: Array.isArray(r.source_files)
        ? (r.source_files as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      error_message: typeof r.error_message === "string" ? r.error_message.slice(0, 2000) : null,
      generation_params:
        r.generation_params && typeof r.generation_params === "object"
          ? (r.generation_params as Record<string, unknown>)
          : {},
    },
  };
}

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseBody(json);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.body;

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret")
    .eq("code", headers.code)
    .maybeSingle();
  if (agentErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  }
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = verifyAgentSignature({
    rawBody,
    headers,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  // Verify clip thuộc org của agent + pe khớp payload.
  const { data: clip } = await admin
    .from("order_proof_clips")
    .select("id, organization_id, packing_event_id, status")
    .eq("id", body.clip_id)
    .maybeSingle();
  if (!clip) {
    return NextResponse.json({ error: "clip_not_found" }, { status: 404 });
  }
  if (clip.organization_id !== agent.organization_id) {
    return NextResponse.json({ error: "clip_cross_org" }, { status: 403 });
  }
  if (clip.packing_event_id !== body.packing_event_id) {
    return NextResponse.json({ error: "clip_pe_mismatch" }, { status: 400 });
  }

  const generationParamsMerged = {
    ...body.generation_params,
    duration_drift_seconds: body.duration_drift_seconds,
  };

  // ============ ENCODING: cập nhật progress_state ============
  if (body.outcome === "encoding") {
    const { error: updErr } = await admin
      .from("order_proof_clips")
      .update({
        progress_state: "encoding",
        source_files: body.source_files,
        generation_params: generationParamsMerged,
      })
      .eq("id", body.clip_id)
      .eq("status", "pending");
    if (updErr) {
      return NextResponse.json(
        { error: "update_failed", message: updErr.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, action: "encoding" });
  }

  // ============ DONE: cập nhật clip metadata, KHÔNG chuyển ready ============
  //
  // Cut completion only records generation metadata.
  // The clip becomes ready only after bucket upload verification and
  // promotion via RPC promote_clip_generation (endpoint clip-upload-complete).
  //
  // Out-of-order callback: nếu `done` đến SAU khi `clip-upload-complete`
  // đã promote xong (row = 'ready'), ta VẪN cho phép update metadata
  // trên row ready. TUYỆT ĐỐI KHÔNG chuyển row ready về pending.
  // Guard qua `.in("status", ["pending", "ready"])` + KHÔNG đụng `status`
  // field trong update payload.
  if (body.outcome === "done") {
    let coveredRange: string | null = null;
    if (body.covered_range_lower && body.covered_range_upper) {
      coveredRange = `[${body.covered_range_lower},${body.covered_range_upper})`;
    }
    const { error: updErr } = await admin
      .from("order_proof_clips")
      .update({
        clip_path: body.clip_path,
        clip_name: body.clip_name,
        clip_started_at: body.clip_started_at,
        clip_ended_at: body.clip_ended_at,
        clip_size_bytes: body.file_size_bytes,
        duration_seconds: body.duration_seconds,
        source_files: body.source_files,
        cut_mode:
          typeof body.generation_params.cut_mode === "string"
            ? (body.generation_params.cut_mode as string)
            : "copy",
        generation_params: generationParamsMerged,
        is_partial: body.is_partial,
        covered_range: coveredRange,
        progress_state: null,
      })
      .eq("id", body.clip_id)
      .in("status", ["pending", "ready"]);
    if (updErr) {
      return NextResponse.json(
        { error: "update_failed", message: updErr.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, action: "done_metadata_updated" });
  }

  // ============ FAILED: chuyển status='failed' + error_message ============
  const { error: updErr } = await admin
    .from("order_proof_clips")
    .update({
      status: "failed",
      error_message: body.error_message,
      generation_params: generationParamsMerged,
      progress_state: null,
    })
    .eq("id", body.clip_id)
    .eq("status", "pending");
  if (updErr) {
    return NextResponse.json(
      { error: "update_failed", message: updErr.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, action: "failed" });
}
