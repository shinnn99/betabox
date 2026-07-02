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
 * 3c: agent xin signed upload URL để đẩy clip lên bucket tạm.
 *
 * Agent KHÔNG giữ Supabase key. Backend giữ, cấp URL upload một lần
 * cho path cố định (agent không ghi bừa đường dẫn). URL có hạn ngắn
 * (~2h — mặc định của Supabase createSignedUploadUrl).
 *
 * Multi-tenant guard:
 *   - Verify agent HMAC.
 *   - Verify packing_event_id thuộc org agent.
 *   - Backend TỰ tính bucket path (`<org_id>/<pe_id>.mp4`) — không
 *     lấy từ payload agent. Agent không thể ghi ra path khác.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  packing_event_id: string;
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
  return { ok: true, body: { packing_event_id: pe } };
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

  const { data: signed, error: signedErr } = await admin.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(bucketPath, { upsert: true });

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
