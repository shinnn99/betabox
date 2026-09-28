import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrganizationContext } from "@/lib/supabase/guard";
import { CAPABILITY, hasCapability, parseSelfReport } from "@/lib/warehouse/self-report";
import { parseEventFailure } from "@/lib/diagnostics/event-failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * UI event mất phản hồi -> xếp MỘT lệnh chẩn đoán đúng agent của tổ chức.
 * Không nhận raw error/body để tránh đưa mật khẩu hoặc dữ liệu khách vào hàng lệnh.
 */
export async function POST(req: Request) {
  const ctx = await requireOrganizationContext(req);
  if (ctx instanceof NextResponse) return ctx;

  const parsed = parseEventFailure(await req.json().catch(() => null));
  if (!parsed) {
    return NextResponse.json({ error: "invalid_diagnostic_event" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: agent, error } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, self_report")
    .eq("id", parsed.agentId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "agent_lookup_failed" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  if (agent.status !== "active") return NextResponse.json({ error: "agent_inactive" }, { status: 409 });
  if (!hasCapability(parseSelfReport(agent.self_report), CAPABILITY.diagnostics)) {
    return NextResponse.json({ error: "diagnostics_not_supported" }, { status: 409 });
  }

  const trigger = {
    event_name: parsed.eventName,
    target_type: parsed.targetType,
    target_id: parsed.targetId,
    failure_kind: parsed.failureKind,
    http_status: parsed.httpStatus,
    error_code: parsed.errorCode,
    occurred_at: parsed.occurredAt,
    correlation_id: parsed.correlationId,
    source: "ui_event_failure",
    actor_user_id: ctx.userId,
    actor_is_platform: ctx.isPlatform,
  };

  // Một cú click có thể đồng thời gặp HTTP 5xx và timeout ở lớp UI. Khi một
  // lệnh cùng event/đối tượng còn pending hoặc taken, dùng lại thay vì đẻ hai
  // lượt quét. Lượt cũ done/failed không chặn lần bấm mới.
  const { data: active } = await admin
    .from("agent_commands")
    .select("id")
    .eq("agent_id", agent.id)
    .eq("type", "collect_diagnostics")
    .in("status", ["pending", "taken"])
    .contains("payload", {
      trigger: {
        event_name: parsed.eventName,
        target_id: parsed.targetId,
        source: "ui_event_failure",
      },
    })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) {
    return NextResponse.json({ ok: true, command_id: active.id, reused: true }, { status: 202 });
  }

  const { data: command, error: insertError } = await admin
    .from("agent_commands")
    .insert({
      organization_id: ctx.organizationId,
      agent_id: agent.id,
      type: "collect_diagnostics",
      payload: { trigger },
    })
    .select("id")
    .single();
  if (insertError || !command) {
    return NextResponse.json({ error: "diagnostic_enqueue_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, command_id: command.id }, { status: 202 });
}
