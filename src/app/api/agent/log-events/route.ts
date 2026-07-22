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
 * Agent push WARN/ERROR log lên cloud. Hạnh đọc bằng SQL trên Supabase
 * Dashboard.
 *
 * Body shape: { events: [{ level, message, emitted_at }] }
 *   - level: 'warn' | 'error' (không debug/info — noise, cần thì thêm sau).
 *   - message: string (agent tự truncate 2KB trước gửi).
 *   - emitted_at: ISO string agent-local (server thêm received_at riêng
 *     để so lệch clock nếu cần).
 *
 * Batch: agent gộp mỗi 30s hoặc flush ngay khi có ERROR. Empty batch OK
 * (idempotent no-op) — không blocker heartbeat.
 *
 * Bản tối thiểu: KHÔNG dashboard tab, KHÔNG buffer offline (mất log khi
 * mất mạng, chấp nhận có ý thức — có AnyDesk bù), KHÔNG rate limit
 * (batch mỗi 30s tự giới hạn).
 */

const MAX_EVENTS_PER_BATCH = 100;
const MAX_MESSAGE_LENGTH = 2048;

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();

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
    canonicalPath: AGENT_API_PATHS.logEvents,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const body = parsed as { events?: unknown };
  if (!Array.isArray(body.events)) {
    return NextResponse.json({ error: "invalid_events" }, { status: 400 });
  }
  if (body.events.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 });
  }
  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    return NextResponse.json({ error: "batch_too_large" }, { status: 400 });
  }

  // Validate + normalize events. Silently drop invalid row thay vì reject
  // cả batch — không muốn 1 event bug làm mất cả batch chứa event quan
  // trọng khác.
  const rows: Array<{
    agent_id: string;
    organization_id: string;
    level: string;
    message: string;
    emitted_at: string;
  }> = [];
  for (const raw of body.events) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as {
      level?: unknown;
      message?: unknown;
      emitted_at?: unknown;
    };
    if (e.level !== "warn" && e.level !== "error") continue;
    if (typeof e.message !== "string" || e.message.length === 0) continue;
    if (typeof e.emitted_at !== "string") continue;
    const parsedTs = Date.parse(e.emitted_at);
    if (!Number.isFinite(parsedTs)) continue;

    rows.push({
      agent_id: agent.id,
      organization_id: agent.organization_id,
      level: e.level,
      message: e.message.length > MAX_MESSAGE_LENGTH
        ? e.message.slice(0, MAX_MESSAGE_LENGTH)
        : e.message,
      emitted_at: new Date(parsedTs).toISOString(),
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, skipped: body.events.length });
  }

  const { error: insErr } = await admin
    .from("agent_log_events")
    .insert(rows);
  if (insErr) {
    console.error("[log-events] insert failed", insErr);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
