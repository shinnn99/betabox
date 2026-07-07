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
 * Boot recovery diff: agent quét ổ hôm nay+hôm qua (RECOVERY_SCAN_DAYS),
 * gọi endpoint này để biết cloud đã có row nào rồi → chỉ upsert file
 * mới. POST vì có body (danh sách file_path để check), và cần HMAC —
 * dùng POST cho nhất quán với các endpoint agent khác.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface KnownRequestBody {
  camera_ids: string[];
  since_iso: string;
}

type ParseOutcome =
  | { ok: true; body: KnownRequestBody }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const cameraIds = r.camera_ids;
  if (!Array.isArray(cameraIds)) return { ok: false, error: "camera_ids_required" };
  if (cameraIds.length === 0) return { ok: false, error: "camera_ids_empty" };
  if (cameraIds.length > 50) return { ok: false, error: "too_many_camera_ids" };
  for (const c of cameraIds) {
    if (typeof c !== "string" || !UUID_RE.test(c)) {
      return { ok: false, error: "camera_id_invalid" };
    }
  }

  const since = typeof r.since_iso === "string" ? r.since_iso.trim() : "";
  if (!since || !Number.isFinite(Date.parse(since))) {
    return { ok: false, error: "since_iso_invalid" };
  }

  return { ok: true, body: { camera_ids: cameraIds as string[], since_iso: since } };
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
    .select("id, organization_id, status, secret, hmac_v2_enforced_at")
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
    canonicalPath: AGENT_API_PATHS.recordingFilesKnown,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Chỉ trả file_path của row do AGENT ghi (source='agent'), không lẫn
  // với row legacy_nextjs. Filter thêm theo since để giới hạn payload.
  const { data: rows, error } = await admin
    .from("camera_recording_files")
    .select("camera_id, file_path, ended_at, duration_seconds")
    .eq("organization_id", agent.organization_id)
    .eq("source", "agent")
    .in("camera_id", body.camera_ids)
    .gte("started_at", body.since_iso);

  if (error) {
    return NextResponse.json(
      { error: "lookup_failed", message: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    files: rows ?? [],
  });
}
