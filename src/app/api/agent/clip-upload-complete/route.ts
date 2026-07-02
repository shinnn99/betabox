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
 * 3c: agent báo upload xong.
 *
 * Backend verify file thật sự tồn tại trong bucket (dùng service_role
 * xem storage.objects) — không tin lời agent nói suông. Rồi update
 * order_proof_clips.bucket_path + bucket_uploaded_at.
 *
 * Bucket path backend TỰ tính từ agent org + packing_event_id, KHÔNG
 * lấy từ payload agent — tương tự upload-url endpoint. Agent không
 * kiểm soát được đường dẫn cuối.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  packing_event_id: string;
  file_size_bytes: number;
}

type ParseOutcome =
  | { ok: true; body: RequestBody }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const pe = typeof r.packing_event_id === "string" ? r.packing_event_id.trim() : "";
  if (!pe || !UUID_RE.test(pe)) {
    return { ok: false, error: "packing_event_id_invalid" };
  }
  const size = Number(r.file_size_bytes);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "file_size_invalid" };
  }
  return { ok: true, body: { packing_event_id: pe, file_size_bytes: size } };
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

  // Multi-tenant: packing_event thuộc org agent?
  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id")
    .eq("id", body.packing_event_id)
    .eq("organization_id", agent.organization_id)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json(
      { error: "packing_event_not_in_org" },
      { status: 403 },
    );
  }

  const bucketPath = bucketPathFor(agent.organization_id, body.packing_event_id);

  // Verify file THẬT SỰ tồn tại trong bucket. supabase-js remove()
  // là destructive → dùng list() cha directory + filter theo name.
  const parentDir = agent.organization_id;
  const fileName = `${body.packing_event_id}.mp4`;
  const { data: files, error: listErr } = await admin.storage
    .from(BUCKET_NAME)
    .list(parentDir, { limit: 100, search: fileName });
  if (listErr) {
    return NextResponse.json(
      { error: "verify_failed", message: listErr.message },
      { status: 500 },
    );
  }
  const found = (files ?? []).find((f) => f.name === fileName);
  if (!found) {
    return NextResponse.json(
      { error: "file_not_in_bucket", bucket_path: bucketPath },
      { status: 409 },
    );
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .from("order_proof_clips")
    .update({
      bucket_path: bucketPath,
      bucket_uploaded_at: nowIso,
    })
    .eq("packing_event_id", body.packing_event_id)
    .eq("organization_id", agent.organization_id);

  if (updErr) {
    return NextResponse.json(
      { error: "update_failed", message: updErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    bucket_path: bucketPath,
    bucket_uploaded_at: nowIso,
  });
}
