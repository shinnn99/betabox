import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cloud → Agent command channel: agent short-polls đây để lấy job pending.
 *
 * Danh tính agent LUÔN lấy từ HMAC (warehouse_agents.code → id). Agent
 * KHÔNG được tự khai agent_id trong body. Body hiện chỉ là "{}".
 *
 * Piggy-back reaper: mỗi request tự chạy reap_stale_agent_commands cho
 * agent này trước khi claim. Đây là chỗ có LỖ đã biết: nếu agent chết
 * im lặng và ngừng poll, job 'taken' của nó không được ai kéo về
 * 'pending'. Với PING vô hại; khi thêm job có side-effect thật cần
 * chuyển sang reaper toàn cục (pg_cron) — xem migration
 * 20260701092259_agent_commands.sql.
 */
const CLAIM_LIMIT = 20;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Optional agent_state.active_recordings do agent Lát 2 gửi kèm poll.
 * Agent Lát 1 gửi body {} — validation phải nuốt được cả hai.
 * Danh sách này dùng để cập nhật last_heartbeat_at cho các session
 * đang có ffmpeg thật sự sống ở agent (RAM), tránh dashboard hiểu nhầm
 * "session recording mà không có heartbeat".
 */
interface ActiveRecordingReport {
  session_id: string;
  camera_id: string;
  pid: number;
  started_at: string;
}

/**
 * 3b-2: agent báo `encoding_busy=true` khi đang encode 1 cut_clip →
 * cloud không claim thêm cut_clip nào cho agent này (job cut_clip
 * nằm `pending` ở cloud, agent poll sau lấy khi rảnh). Khi rảnh →
 * cloud claim tối đa 1 cut_clip mỗi lần (type khác không giới hạn).
 *
 * Ranh giới: 1-in-flight LÀ per-agent. Multi-agent (dù đang cọc)
 * mỗi cái có encode gate riêng — hai agent chạy 2 encode song song
 * là ĐÚNG, không phải bug.
 */
function parseEncodingBusy(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const v = (raw as Record<string, unknown>).encoding_busy;
  return v === true;
}

function parseAgentState(raw: unknown): ActiveRecordingReport[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const state = r.agent_state;
  if (!state || typeof state !== "object") return [];
  const list = (state as Record<string, unknown>).active_recordings;
  if (!Array.isArray(list)) return [];
  const out: ActiveRecordingReport[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const sessionId = typeof it.session_id === "string" ? it.session_id : "";
    const cameraId = typeof it.camera_id === "string" ? it.camera_id : "";
    const pid = typeof it.pid === "number" ? it.pid : 0;
    const startedAt = typeof it.started_at === "string" ? it.started_at : "";
    if (!UUID_RE.test(sessionId)) continue;
    if (!UUID_RE.test(cameraId)) continue;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ session_id: sessionId, camera_id: cameraId, pid, started_at: startedAt });
  }
  return out;
}

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();

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

  // Reap stale 'taken' jobs cho chính agent này trước khi claim.
  // Timeout thực thi nằm trong RPC (CASE hardcoded theo type).
  await admin.rpc("reap_stale_agent_commands", { p_agent_id: agent.id });

  // 3b-2: đọc encoding_busy từ body (fallback false) để quyết cách
  // claim. Body cũng dùng cho agent_state parsing bên dưới → parse
  // 1 lần, dùng nhiều lần.
  let parsedBody: unknown = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }
  }
  const encodingBusy = parseEncodingBusy(parsedBody);

  const excludeTypes = encodingBusy ? ["cut_clip"] : [];
  const typeLimits = encodingBusy ? {} : { cut_clip: 1 };

  const { data: claimed, error: claimErr } = await admin.rpc(
    "claim_agent_commands",
    {
      p_agent_id: agent.id,
      p_limit: CLAIM_LIMIT,
      p_exclude_types: excludeTypes,
      p_type_limits: typeLimits,
    },
  );
  if (claimErr) {
    return NextResponse.json(
      { error: "claim_failed", message: claimErr.message },
      { status: 500 },
    );
  }

  const nowIso = new Date().toISOString();
  await admin
    .from("warehouse_agents")
    .update({ last_seen_at: nowIso })
    .eq("id", agent.id);

  // agent_state là optional. Parse dùng lại `parsedBody` đã parse ở
  // đầu cho encoding_busy. Không fail request nếu body cũ dạng {}
  // hoặc format lạ.
  const activeRecordings = parseAgentState(parsedBody);
  if (activeRecordings.length > 0) {
    const sessionIds = activeRecordings.map((r) => r.session_id);
    // last_heartbeat_at chỉ được set cho session đúng org, đúng
    // status='recording'. Session status khác (stopped/error) không
    // được tô hồng bởi agent — nếu agent còn báo heartbeat cho session
    // đã bị cloud đánh dấu stop, đó là dấu hiệu cần reconcile (Lát
    // sau).
    await admin
      .from("camera_recording_sessions")
      .update({ last_heartbeat_at: nowIso })
      .in("id", sessionIds)
      .eq("organization_id", agent.organization_id)
      .eq("status", "recording");
  }

  return NextResponse.json({
    ok: true,
    commands: claimed ?? [],
  });
}
