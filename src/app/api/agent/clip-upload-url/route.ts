import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentRequest,
} from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";
import { BUCKET_NAME, bucketPathFor } from "@/lib/watch/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent xin signed upload URL để đẩy clip lên bucket tạm.
 *
 * Safe-retry S6 2026-07-06:
 *   - Nhận `clip_id` (identity generation).
 *   - Bucket path v2: `{org}/{pe}/{clip_id}.mp4`. Backend tự tính, KHÔNG
 *     lấy từ payload agent.
 *   - Verify clip thuộc org agent + status='pending' (generation đang xử lý).
 *   - `upsert: false` — mỗi generation upload đúng 1 lần vào path riêng
 *     nên retry-with-same-clip-id không thể ghi đè path khác.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  clip_id: string;
  packing_event_id: string;
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
  return { ok: true, body: { clip_id: clipId, packing_event_id: pe } };
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

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.clipUploadUrl,
    headers,
    agentId: agent.id,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Verify clip thuộc org agent + pe khớp payload + đang ở pending.
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
  if (clip.status !== "pending") {
    return NextResponse.json(
      { error: "clip_not_pending", status: clip.status },
      { status: 409 },
    );
  }

  const bucketPath = bucketPathFor(
    agent.organization_id,
    body.packing_event_id,
    body.clip_id,
  );

  const { data: signed, error: signedErr } = await admin.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(bucketPath, { upsert: false });

  if (signedErr || !signed) {
    return NextResponse.json(
      {
        error: "signed_url_failed",
        message: signedErr?.message ?? "unknown",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    bucket_path: bucketPath,
    signed_url: signed.signedUrl,
    token: signed.token,
  });
}
