import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent báo kết quả job (done|failed) sau khi xử lý.
 *
 * Điều kiện đóng job: job đang 'taken' và agent_id của job trùng agent
 * đã xác thực HMAC. Nếu reaper đã kéo job về 'pending' trong lúc agent
 * xử lý (agent chậm hơn visibility timeout) → job không còn ở 'taken'
 * nữa → trả 409 stale_command. Agent chỉ log rồi bỏ; job sẽ được claim
 * lại ở lần poll kế. Đây là bản chất at-least-once — handler phải
 * idempotent.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResultBody {
  command_id: string;
  status: "done" | "failed";
  result: Record<string, unknown> | null;
  error_message: string | null;
}

type ParseOutcome = { ok: true; body: ResultBody } | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const commandId = typeof r.command_id === "string" ? r.command_id.trim() : "";
  if (!commandId) return { ok: false, error: "command_id_required" };
  if (!UUID_RE.test(commandId)) return { ok: false, error: "command_id_invalid" };

  const status = typeof r.status === "string" ? r.status.trim() : "";
  if (status !== "done" && status !== "failed") {
    return { ok: false, error: "status_invalid" };
  }

  const result =
    r.result && typeof r.result === "object"
      ? (r.result as Record<string, unknown>)
      : null;

  const errorMsg = typeof r.error === "string" ? r.error.trim() : "";
  if (status === "failed" && !errorMsg) {
    return { ok: false, error: "error_required_when_failed" };
  }

  return {
    ok: true,
    body: {
      command_id: commandId,
      status,
      result,
      error_message: errorMsg || null,
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
    .select("id, status, secret")
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

  // Atomic close: chỉ update khi status='taken' và agent_id khớp.
  // Agent A không được đóng job của agent B kể cả khi biết command_id.
  // SELECT thêm type + payload để nhánh probe_codec xử side-effect ghi
  // cameras.codec_detected.
  const { data: updated, error: updateErr } = await admin
    .from("agent_commands")
    .update({
      status: body.status,
      completed_at: new Date().toISOString(),
      result: body.result,
      error: body.error_message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.command_id)
    .eq("agent_id", agent.id)
    .eq("status", "taken")
    .select("id, type, payload, organization_id")
    .maybeSingle();

  if (updateErr) {
    return NextResponse.json(
      { error: "update_failed", message: updateErr.message },
      { status: 500 },
    );
  }
  if (!updated) {
    // Job đã bị reaper trả về pending, hoặc thuộc agent khác, hoặc
    // không tồn tại. Agent log rồi bỏ — không retry ở tầng này.
    return NextResponse.json({ error: "stale_command" }, { status: 409 });
  }

  // 1.2: nhánh probe_codec ghi kết quả vào cameras.codec_detected.
  // Chỉ ghi khi status=done + result có codec. Nếu failed → ghi
  // codec_probe_error (giữ codec_detected cũ, không xóa vì probe cũ
  // vẫn là fact quan sát được trước đó).
  if (updated.type === "probe_codec") {
    const payload = updated.payload as { camera_id?: string } | null;
    const cameraId = payload?.camera_id;
    if (cameraId) {
      const nowIso = new Date().toISOString();
      if (body.status === "done" && body.result) {
        const codec = typeof body.result.codec === "string"
          ? body.result.codec.trim().toLowerCase().slice(0, 50)
          : null;
        const warning = typeof body.result.warning === "string"
          ? body.result.warning.trim().slice(0, 100)
          : null;
        await admin
          .from("cameras")
          .update({
            codec_detected: codec,
            codec_warning: warning,
            codec_probed_at: nowIso,
            codec_probe_error: null,
            updated_at: nowIso,
          })
          .eq("id", cameraId)
          .eq("organization_id", updated.organization_id);
      } else if (body.status === "failed") {
        await admin
          .from("cameras")
          .update({
            codec_probed_at: nowIso,
            codec_probe_error: (body.error_message ?? "unknown").slice(0, 200),
            updated_at: nowIso,
          })
          .eq("id", cameraId)
          .eq("organization_id", updated.organization_id);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
