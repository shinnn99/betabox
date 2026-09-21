import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAgentHeaders, verifyAgentRequest } from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent báo về phiên ghi hoàn.
 *
 *   ack    — đã nhận tín hiệu BẬT. Trước mốc này chưa segment nào mang
 *            nhãn, nên cloud cũng không được coi là có gì để rút.
 *   finish — đã lưu xong đoạn video cuối của phiên, kèm mốc kết thúc của
 *            chính đoạn đó. Đây là phần "chạy ngầm tới khi lưu xong" mà
 *            chủ dự án yêu cầu: nó nằm ở agent, không phụ thuộc trình
 *            duyệt còn mở hay không.
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) return NextResponse.json({ error: "missing_headers" }, { status: 400 });

  const rawBody = await req.text();

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret, hmac_v2_enforced_at")
    .eq("code", headers.code)
    .maybeSingle();
  if (agentErr) return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.returnCapture,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  let body: { capture_id?: unknown; action?: unknown; last_segment_ended_at?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const captureId = typeof body.capture_id === "string" ? body.capture_id.trim() : "";
  if (!UUID_RE.test(captureId)) {
    return NextResponse.json({ error: "capture_id_invalid" }, { status: 400 });
  }
  const action = body.action === "ack" || body.action === "finish" ? body.action : null;
  if (!action) return NextResponse.json({ error: "action_invalid" }, { status: 400 });

  // Phiên phải thuộc tổ chức của agent — không tin capture_id từ body.
  const { data: period, error: periodErr } = await admin
    .from("station_mode_periods")
    .select("id, organization_id, capture_state")
    .eq("id", captureId)
    .maybeSingle();
  if (periodErr) return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  if (!period || period.organization_id !== agent.organization_id) {
    return NextResponse.json({ error: "capture_not_found" }, { status: 404 });
  }

  if (action === "ack") {
    const { data, error } = await admin.rpc("ack_return_capture", { p_capture_id: captureId });
    if (error) {
      return NextResponse.json({ error: "ack_failed", message: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: Boolean(data), state: period.capture_state });
  }

  const endedAt =
    typeof body.last_segment_ended_at === "string" && body.last_segment_ended_at
      ? body.last_segment_ended_at
      : null;
  const { data, error } = await admin.rpc("finish_return_capture", {
    p_capture_id: captureId,
    p_last_segment_ended_at: endedAt,
  });
  if (error) {
    return NextResponse.json({ error: "finish_failed", message: error.message }, { status: 500 });
  }
  // false = phiên đã ở trạng thái cuối rồi (lệnh giao hai lần). Vẫn trả 200
  // để agent xoá phiên khỏi cache, không lặp mãi.
  return NextResponse.json({ ok: true, updated: Boolean(data) });
}
