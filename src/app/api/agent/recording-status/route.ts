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
 * Agent báo event bất thường về recording (spawn/exit/respawn/give-up).
 * Ghi vào camera_recording_sessions.status/error_message/last_heartbeat_at.
 *
 * Liveness "vẫn đang ghi" KHÔNG đi qua endpoint này — nó nhồi vào body
 * poll-commands để đỡ round-trip. Endpoint này chỉ dành cho event
 * KHÔNG khớp nhịp poll (ffmpeg vừa chết, respawn OK, retry cạn...).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StatusEvent =
  | "recording"
  | "stopped"
  | "error"
  | "degraded"
  | "error_prolonged"
  | "credentials_unavailable";

interface RecordingStatusBody {
  session_id: string;
  camera_id: string;
  status: StatusEvent;
  error_message: string | null;
  pid: number | null;
  // 3b-2 followup: codec detection tách sự thật (`codec_detected`)
  // khỏi diễn giải (`codec_warning`). Cả hai optional (probe fail
  // hoặc agent Lát 2 không gửi).
  codec_detected: string | null;
  codec_warning: string | null;
}

type ParseOutcome =
  | { ok: true; body: RecordingStatusBody }
  | { ok: false; error: string };

const VALID_STATUSES: StatusEvent[] = [
  "recording",
  "stopped",
  "error",
  "degraded",
  "error_prolonged",
  "credentials_unavailable",
];

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const sessionId = typeof r.session_id === "string" ? r.session_id.trim() : "";
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return { ok: false, error: "session_id_invalid" };
  }

  const cameraId = typeof r.camera_id === "string" ? r.camera_id.trim() : "";
  if (!cameraId || !UUID_RE.test(cameraId)) {
    return { ok: false, error: "camera_id_invalid" };
  }

  const status = typeof r.status === "string" ? r.status.trim() : "";
  if (!VALID_STATUSES.includes(status as StatusEvent)) {
    return { ok: false, error: "status_invalid" };
  }

  const errorMsg =
    typeof r.error_message === "string" ? r.error_message.slice(0, 2000) : null;
  const pid =
    typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 0
      ? r.pid
      : null;

  // codec_detected/warning optional. Cap 50 chars — codec name ngắn,
  // chuỗi dài là dấu hiệu payload lạ.
  const codecDetected =
    typeof r.codec_detected === "string" && r.codec_detected.trim()
      ? r.codec_detected.trim().slice(0, 50)
      : null;
  const codecWarning =
    typeof r.codec_warning === "string" && r.codec_warning.trim()
      ? r.codec_warning.trim().slice(0, 50)
      : null;

  return {
    ok: true,
    body: {
      session_id: sessionId,
      camera_id: cameraId,
      status: status as StatusEvent,
      error_message: errorMsg,
      pid,
      codec_detected: codecDetected,
      codec_warning: codecWarning,
    },
  };
}

// Map từ status event của agent → status column của camera_recording_sessions.
// Bảng cũ chỉ có 'recording' | 'stopped' | 'error'. Degraded / prolonged
// / credentials_unavailable đều map về 'error' về mặt status, nhưng lưu
// nguyên loại trong error_message để dashboard phân biệt được.
function mapToDbStatus(s: StatusEvent): "recording" | "stopped" | "error" {
  if (s === "recording") return "recording";
  if (s === "stopped") return "stopped";
  return "error";
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
    canonicalPath: AGENT_API_PATHS.recordingStatus,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  const dbStatus = mapToDbStatus(body.status);
  const nowIso = new Date().toISOString();
  const errorMessageForDb =
    body.status === "recording" || body.status === "stopped"
      ? null
      : body.error_message ?? body.status;

  const updates: Record<string, unknown> = {
    status: dbStatus,
    error_message: errorMessageForDb,
    last_heartbeat_at: nowIso,
    updated_at: nowIso,
  };
  if (body.status === "stopped") {
    updates.stopped_at = nowIso;
  }
  // 3b-2 followup: chỉ set codec fields khi agent GỬI giá trị. Không
  // overwrite khi report event khác (VD degraded/error, không có
  // codec info) — giữ nguyên codec_detected/warning từ report trước.
  if (body.codec_detected !== null) {
    updates.codec_detected = body.codec_detected;
  }
  if (body.codec_warning !== null) {
    updates.codec_warning = body.codec_warning;
  }

  const { data: updated, error: updateErr } = await admin
    .from("camera_recording_sessions")
    .update(updates)
    .eq("id", body.session_id)
    .eq("organization_id", agent.organization_id)
    .eq("camera_id", body.camera_id)
    .select("id")
    .maybeSingle();

  if (updateErr) {
    return NextResponse.json(
      { error: "update_failed", message: updateErr.message },
      { status: 500 },
    );
  }
  if (!updated) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
