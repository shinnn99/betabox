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
 * Boot-declare: agent khai báo sau boot recovery (B2 CRIT-1 + lưới quét
 * marker) danh sách camera CÓ ffmpeg đang chạy thật. Endpoint đóng
 * (`stopped` + error_message='agent_boot_declared_clean') mọi session
 * `recording`/`connection_lost` của ORG NÀY thuộc camera KHÔNG nằm
 * trong `alive_camera_ids`.
 *
 * Kịch bản chính (kho tắt tối bật sáng):
 *   - Registry rỗng + không ffmpeg sống → agent gọi với alive=[] → cloud
 *     đóng session `connection_lost` treo → lifecycle.boot() spawn sạch.
 *
 * QUYỀN PHÁ hàng loạt. Ranh giới chặn:
 *   - `organization_id` SUY từ agent đã xác thực (agent.organization_id),
 *     KHÔNG đọc từ body. Kẻ có HMAC agent A gửi org B trong body → vẫn
 *     chỉ đóng session của org A.
 *   - Schema hiện tại 1-org-1-agent (cameras không có warehouse_agent_id),
 *     nên filter theo org đủ. Multi-agent-per-org là nợ Mốc 3.
 *   - camera_id trong alive_camera_ids → giữ nguyên (KHÔNG đóng).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BootDeclareBody {
  alive_camera_ids: string[];
}

type ParseOutcome =
  | { ok: true; body: BootDeclareBody }
  | { ok: false; error: string };

function parseBody(raw: unknown): ParseOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.alive_camera_ids)) {
    return { ok: false, error: "alive_camera_ids_invalid" };
  }
  if (r.alive_camera_ids.length > 500) {
    return { ok: false, error: "alive_camera_ids_too_many" };
  }
  const alive: string[] = [];
  for (const item of r.alive_camera_ids) {
    if (typeof item !== "string" || !UUID_RE.test(item.trim())) {
      return { ok: false, error: "camera_id_invalid" };
    }
    alive.push(item.trim());
  }
  return { ok: true, body: { alive_camera_ids: alive } };
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
    canonicalPath: AGENT_API_PATHS.bootDeclare,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  // Đóng session recording/connection_lost của ORG agent (suy từ auth),
  // TRỪ camera trong alive_camera_ids. `.eq("organization_id", agent.organization_id)`
  // là lớp chặn cross-tenant duy nhất — sai/thiếu = phá cả 5-10 khách.
  //
  // Lưu ý: dùng `.not("camera_id", "in", ...)` với danh sách rỗng dễ sinh
  // SQL "NOT IN ()" invalid. Tách 2 nhánh:
  //   - alive rỗng → đóng mọi session của org (không loại trừ gì).
  //   - alive có phần tử → đóng session không trong alive.
  const nowIso = new Date().toISOString();
  let updateQuery = admin
    .from("camera_recording_sessions")
    .update({
      status: "stopped",
      stopped_at: nowIso,
      updated_at: nowIso,
      error_message: "agent_boot_declared_clean",
    })
    .eq("organization_id", agent.organization_id)
    .in("status", ["recording", "connection_lost"]);

  if (body.alive_camera_ids.length > 0) {
    // PostgREST: `.not("camera_id", "in", "(uuid1,uuid2)")` cần chuỗi
    // in-list dạng `(v1,v2)`. Supabase-js hỗ trợ array trực tiếp.
    updateQuery = updateQuery.not(
      "camera_id",
      "in",
      `(${body.alive_camera_ids.join(",")})`,
    );
  }

  const { data: updated, error: updErr } = await updateQuery.select("id");

  if (updErr) {
    return NextResponse.json(
      { error: "update_failed", message: updErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    closed: (updated ?? []).length,
    kept_alive: body.alive_camera_ids.length,
  });
}
