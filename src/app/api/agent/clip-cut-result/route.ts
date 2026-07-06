import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent báo kết quả cắt clip. Cloud upsert row vào order_proof_clips
 * (một row per packing_event_id).
 *
 * Trạng thái map:
 *   status='ready'  = clip cắt xong, phát được. Có thể is_partial=true
 *                     nếu khoảng target chứa gap.
 *   status='failed' = cắt lỗi (segments thiếu, ffmpeg fail, ...).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Outcome map từ agent → row `order_proof_clips`:
 *   'encoding' — agent bắt đầu cắt: upsert `status='pending',
 *                progress_state='encoding'`. UI hiện "đang cắt clip".
 *                (Tên `encoding` giữ vì DB CHECK constraint chốt giá
 *                trị này; thực chất là copy-stream 1-3s sau chốt
 *                2026-07-05, không phải reencode.)
 *   'done'     — cắt xong: upsert `status='ready'`. Bao cả ca
 *                idempotent-reuse (agent thấy file cũ hợp lệ, gửi
 *                `generation_params.idempotent_reuse=true`).
 *   'failed'   — cắt lỗi: upsert `status='failed'`.
 *
 * Backend TỰ set `progress_state=null` khi outcome final — agent không
 * cần gửi tường minh (mỗi field một nơi quyết).
 *
 * 'skipped' cũ (idempotent hit không insert row) đã bỏ 2026-07-06: agent
 * giờ luôn upsert row `done` với `idempotent_reuse=true` — bảo đảm row
 * tồn tại cho /watch, đóng nguồn bug 32-command-done-0-row.
 */
type Outcome = "done" | "failed" | "encoding";

interface ResultBody {
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

  const packingEventId = typeof r.packing_event_id === "string" ? r.packing_event_id.trim() : "";
  if (!UUID_RE.test(packingEventId)) return { ok: false, error: "packing_event_id_invalid" };

  const cameraId = typeof r.camera_id === "string" ? r.camera_id.trim() : "";
  if (!UUID_RE.test(cameraId)) return { ok: false, error: "camera_id_invalid" };

  const waybillCode = typeof r.waybill_code === "string" ? r.waybill_code.trim() : "";
  if (!waybillCode) return { ok: false, error: "waybill_code_required" };

  const outcomeRaw = typeof r.outcome === "string" ? r.outcome.trim() : "";
  if (
    outcomeRaw !== "done" &&
    outcomeRaw !== "failed" &&
    outcomeRaw !== "encoding"
  ) {
    return { ok: false, error: "outcome_invalid" };
  }

  return {
    ok: true,
    body: {
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

  // Verify packing_event thuộc org agent.
  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id")
    .eq("id", body.packing_event_id)
    .eq("organization_id", agent.organization_id)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json({ error: "packing_event_not_in_org" }, { status: 403 });
  }

  const nowIso = new Date().toISOString();

  // 3b-2: outcome='encoding' → row báo "đang xử lý", status vòng đời
  // là 'pending' (chưa xong), progress_state='encoding' (chi tiết).
  // KHÔNG xóa row cũ (retry với cùng packing_event_id chỉ update).
  if (body.outcome === "encoding") {
    // Upsert bằng delete + insert như flow hiện tại vẫn hoạt động,
    // nhưng ở đây row chưa có clip data đầy đủ → chỉ insert row đơn
    // giản. Nếu row cũ ready/failed từ lần trước cho cùng
    // packing_event_id, delete để bắt đầu lại vòng đời mới.
    await admin
      .from("order_proof_clips")
      .delete()
      .eq("packing_event_id", body.packing_event_id)
      .eq("organization_id", agent.organization_id);
    const encodingRow: Record<string, unknown> = {
      organization_id: agent.organization_id,
      packing_event_id: body.packing_event_id,
      camera_id: body.camera_id,
      waybill_code: body.waybill_code,
      status: "pending",
      progress_state: "encoding",
      cut_mode:
        body.generation_params &&
        typeof (body.generation_params as Record<string, unknown>).cut_mode === "string"
          ? ((body.generation_params as Record<string, unknown>).cut_mode as string)
          : "reencode",
      generation_params: body.generation_params,
      source_files: body.source_files,
    };
    const { error: insErr } = await admin.from("order_proof_clips").insert(encodingRow);
    if (insErr) {
      return NextResponse.json(
        { error: "insert_failed", message: insErr.message },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, action: "encoding" });
  }

  const status = body.outcome === "done" ? "ready" : "failed";

  // Build tstzrange literal cho covered_range (Postgres cần string
  // format '[iso,iso)' — half-open interval, chuẩn cho khoảng thời
  // gian). Chỉ set nếu cả hai đầu có.
  let coveredRange: string | null = null;
  if (body.covered_range_lower && body.covered_range_upper) {
    coveredRange = `[${body.covered_range_lower},${body.covered_range_upper})`;
  }

  const row: Record<string, unknown> = {
    organization_id: agent.organization_id,
    packing_event_id: body.packing_event_id,
    camera_id: body.camera_id,
    waybill_code: body.waybill_code,
    clip_path: body.clip_path,
    clip_name: body.clip_name,
    clip_started_at: body.clip_started_at,
    clip_ended_at: body.clip_ended_at,
    clip_size_bytes: body.file_size_bytes,
    duration_seconds: body.duration_seconds,
    source_files: body.source_files,
    status,
    error_message: body.outcome === "failed" ? body.error_message : null,
    cut_mode:
      body.generation_params &&
      typeof (body.generation_params as Record<string, unknown>).cut_mode === "string"
        ? ((body.generation_params as Record<string, unknown>).cut_mode as string)
        : "copy",
    generation_params: {
      ...body.generation_params,
      duration_drift_seconds: body.duration_drift_seconds,
    },
    generated_at: body.outcome === "done" ? nowIso : null,
    is_partial: body.is_partial,
    covered_range: coveredRange,
    // 3b-2: backend TỰ set progress_state=null cho outcome final,
    // KHÔNG lấy từ agent. Mỗi field một nơi quyết.
    progress_state: null,
  };

  // Không có unique constraint theo packing_event_id ở tầng DB (chỉ
  // có partial unique where status='ready'). Xoá row cũ (bất kể
  // status) rồi insert mới — 3a-2 mỗi packing_event_id có tối đa 1
  // row do agent ghi. Route Next.js cũ có thể vẫn insert row với
  // cùng packing_event_id (cắt song song), nhưng đó là chuyện của
  // BLOCKS-GO-LIVE ở enqueue.ts — 3a-2 chỉ chịu trách nhiệm về row
  // do agent tạo.
  await admin
    .from("order_proof_clips")
    .delete()
    .eq("packing_event_id", body.packing_event_id)
    .eq("organization_id", agent.organization_id);

  const { error: insErr } = await admin.from("order_proof_clips").insert(row);
  if (insErr) {
    return NextResponse.json(
      { error: "insert_failed", message: insErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, action: status });
}
