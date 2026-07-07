import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentRequest,
} from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HIGH-13 (B4): endpoint verify `.stale` marker của agent.
 *
 * Agent gọi endpoint này TRƯỚC khi rename tmp → canonical trong boot
 * recovery. Backend so `{clip_id, packing_event_id, bucket_path}` với
 * DB `order_proof_clips`. Nếu match và clip status='ready' → OK, agent
 * tiến hành recovery. Nếu mismatch hoặc clip không tồn tại → agent
 * quarantine marker + tmp, KHÔNG rename/xóa canonical.
 *
 * Bảo vệ evidence integrity: nếu marker corrupt hoặc pe_id trong marker
 * sai (log bị đè, disk corruption, hoặc tấn công), canonical đúng của
 * PE khác KHÔNG bị xóa.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface VerifyBody {
  clip_id: string;
  packing_event_id: string;
  bucket_path: string;
}

type ParseOutcome =
  | { ok: true; body: VerifyBody }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;
  const clipId = typeof r.clip_id === "string" ? r.clip_id.trim() : "";
  if (!UUID_RE.test(clipId)) return { ok: false, error: "clip_id_invalid" };
  const peId = typeof r.packing_event_id === "string" ? r.packing_event_id.trim() : "";
  if (!UUID_RE.test(peId)) return { ok: false, error: "packing_event_id_invalid" };
  const bucketPath = typeof r.bucket_path === "string" ? r.bucket_path.trim() : "";
  if (bucketPath.length < 5 || bucketPath.length > 500) {
    return { ok: false, error: "bucket_path_invalid" };
  }
  return {
    ok: true,
    body: { clip_id: clipId, packing_event_id: peId, bucket_path: bucketPath },
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

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.verifyClipStaleMarker,
    headers,
    agentId: agent.id,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Query DB — clip có tồn tại và thuộc org agent + match pe_id + bucket_path.
  const { data: clip, error: clipErr } = await admin
    .from("order_proof_clips")
    .select("id, organization_id, packing_event_id, bucket_path, status")
    .eq("id", body.clip_id)
    .maybeSingle();
  if (clipErr) {
    return NextResponse.json(
      { error: "db_lookup_failed", message: clipErr.message },
      { status: 500 },
    );
  }

  // KHÔNG tồn tại → agent quarantine.
  if (!clip) {
    return NextResponse.json({
      verdict: "quarantine",
      reason: "clip_not_found",
    });
  }

  // Cross-tenant guard: clip phải thuộc org agent.
  if (clip.organization_id !== agent.organization_id) {
    console.warn(
      `[verify-stale] cross-tenant clip agent=${agent.id} clip=${clip.id} clip_org=${clip.organization_id} agent_org=${agent.organization_id}`,
    );
    return NextResponse.json({
      verdict: "quarantine",
      reason: "cross_tenant",
    });
  }

  // Match pe_id (marker có thể corrupt).
  if (clip.packing_event_id !== body.packing_event_id) {
    return NextResponse.json({
      verdict: "quarantine",
      reason: "packing_event_mismatch",
      expected: clip.packing_event_id,
    });
  }

  // Match bucket_path.
  if (clip.bucket_path !== body.bucket_path) {
    return NextResponse.json({
      verdict: "quarantine",
      reason: "bucket_path_mismatch",
      expected: clip.bucket_path,
    });
  }

  // Clip phải ở status 'ready' (promote đã xảy ra) — recovery chỉ đúng
  // khi bucket đã có clip mới, ổ local cần rename tmp → canonical.
  if (clip.status !== "ready") {
    return NextResponse.json({
      verdict: "quarantine",
      reason: "clip_not_ready",
      status: clip.status,
    });
  }

  return NextResponse.json({
    verdict: "recover",
    clip_id: clip.id,
    packing_event_id: clip.packing_event_id,
  });
}
