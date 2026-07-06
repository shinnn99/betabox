import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";
import { BUCKET_NAME, bucketPathFor } from "@/lib/watch/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent báo upload xong → backend verify object + gọi RPC promote.
 *
 * Safe-retry S6 2026-07-06:
 *   - Nhận `clip_id` (identity generation).
 *   - Backend tự tính bucket path v2 `{org}/{pe}/{clip_id}.mp4` — không
 *     tin agent payload.
 *   - Verify file THẬT SỰ tồn tại trong bucket bằng HEAD lookup chính xác
 *     (không dùng `list + search` — tránh match nhầm object khác).
 *   - Gọi RPC `promote_clip_generation` để flip DB atomic:
 *       lần đầu: pending → ready.
 *       retry:   ready cũ → superseded + pending mới → ready.
 *     RPC idempotent → callback replay trả 'already_promoted' vẫn OK.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  clip_id: string;
  packing_event_id: string;
  file_size_bytes: number;
}

type ParseOutcome =
  | { ok: true; body: RequestBody }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const clipId = typeof r.clip_id === "string" ? r.clip_id.trim() : "";
  if (!UUID_RE.test(clipId)) return { ok: false, error: "clip_id_invalid" };
  const pe = typeof r.packing_event_id === "string" ? r.packing_event_id.trim() : "";
  if (!UUID_RE.test(pe)) return { ok: false, error: "packing_event_id_invalid" };
  const size = Number(r.file_size_bytes);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "file_size_invalid" };
  return {
    ok: true,
    body: { clip_id: clipId, packing_event_id: pe, file_size_bytes: size },
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

  // Verify clip thuộc org agent + pe khớp.
  const { data: clip } = await admin
    .from("order_proof_clips")
    .select(
      "id, organization_id, packing_event_id, status, generation_params",
    )
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

  // Backend tự tính bucket path v2.
  const bucketPath = bucketPathFor(
    agent.organization_id,
    body.packing_event_id,
    body.clip_id,
  );

  // Verify object THẬT SỰ tồn tại trong bucket. Dùng list parent với
  // search bằng đúng basename để lấy object metadata (Supabase SDK
  // không expose head trực tiếp — list + search theo tên chính xác đủ
  // an toàn ở đây vì tên = clip_id là UUID duy nhất).
  const parentDir = `${agent.organization_id}/${body.packing_event_id}`;
  const fileName = `${body.clip_id}.mp4`;
  const { data: files, error: listErr } = await admin.storage
    .from(BUCKET_NAME)
    .list(parentDir, { limit: 10, search: fileName });
  if (listErr) {
    return NextResponse.json(
      { error: "verify_failed", message: listErr.message },
      { status: 500 },
    );
  }
  const found = (files ?? []).find((f) => f.name === fileName);
  if (!found) {
    // Chỉ signal cho generation MỚI (new). Không suy diễn về clip cũ —
    // clip cũ (nếu có) do /watch xử lý playback riêng.
    return NextResponse.json(
      { error: "new_generation_file_not_in_bucket", bucket_path: bucketPath },
      { status: 409 },
    );
  }

  // Đọc replaces_clip_id từ generation_params (resolver đã lưu ở
  // enqueue). RPC chấp nhận NULL cho lần cắt đầu.
  const genParams = (clip.generation_params as Record<string, unknown> | null) ?? {};
  const replacesRaw = genParams.replaces_clip_id;
  const oldClipId =
    typeof replacesRaw === "string" && UUID_RE.test(replacesRaw)
      ? replacesRaw
      : null;

  // Gọi RPC promote — atomic + idempotent.
  const { data: rpcResult, error: rpcErr } = await admin.rpc(
    "promote_clip_generation",
    {
      p_new_clip_id: body.clip_id,
      p_packing_event_id: body.packing_event_id,
      p_bucket_path: bucketPath,
      p_old_clip_id: oldClipId,
    },
  );
  if (rpcErr) {
    return NextResponse.json(
      { error: "promote_failed", message: rpcErr.message },
      { status: 500 },
    );
  }

  const promoteStatus = typeof rpcResult === "string" ? rpcResult : "unknown";
  if (
    promoteStatus !== "promoted_first" &&
    promoteStatus !== "promoted_retry" &&
    promoteStatus !== "already_promoted"
  ) {
    return NextResponse.json(
      { error: "promote_unexpected_status", promote_status: promoteStatus },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    bucket_path: bucketPath,
    promote_status: promoteStatus,
  });
}
