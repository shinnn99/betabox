import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";
import { CAPABILITY, hasCapability, parseSelfReport } from "@/lib/warehouse/self-report";
import { isMissingColumnError } from "@/lib/supabase/missing-column";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ============================================================================
// /api/platform/agents/[id]/diagnostics — Thu chẩn đoán từ xa (kế hoạch
// VAN-HANH-NHIEU-KHO, đợt 7). Thay cho việc nhờ người ở kho gõ lệnh.
//
// POST: xếp lệnh `collect_diagnostics` cho agent. Lệnh chỉ ĐỌC trạng thái
//       trên máy kho, không đổi gì — nên platform_support được bấm.
//       Agent chưa khai khả năng này (bản ≤ 0.12.x) → 409, không xếp lệnh
//       mà agent sẽ trả `unknown_type`.
// GET : kết quả lần thu gần nhất.
//
// GIỚI HẠN: lệnh chỉ chạy khi agent còn sống. Agent chết thì vẫn phải có
// người tới kho (kế hoạch 4.6).
// ============================================================================

export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: agent, error } = await admin
    .from("warehouse_agents")
    .select("id, code, organization_id, status, self_report")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    const missing = isMissingColumnError(error, "self_report");
    return NextResponse.json(
      {
        error: missing ? "self_report_unavailable" : "db_error",
        message: missing ? "Cần chạy migration 20260926130000 trước." : error.message,
      },
      { status: missing ? 503 : 500 },
    );
  }
  if (!agent) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_inactive", message: "Agent đang tắt." }, { status: 409 });
  }
  if (!hasCapability(parseSelfReport(agent.self_report), CAPABILITY.diagnostics)) {
    return NextResponse.json(
      {
        error: "not_supported",
        message: "Máy kho chạy bản agent chưa biết lệnh này — cần agent 0.13.0 trở lên.",
      },
      { status: 409 },
    );
  }

  const { data: cmd, error: insErr } = await admin
    .from("agent_commands")
    .insert({ organization_id: agent.organization_id, agent_id: agent.id, type: "collect_diagnostics", payload: {} })
    .select("id")
    .single();
  if (insErr || !cmd) {
    return NextResponse.json({ error: "enqueue_failed", message: insErr?.message ?? "" }, { status: 500 });
  }

  const audit = await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: null,
    action: "platform.agent.collect_diagnostics",
    targetType: "organization",
    targetId: agent.organization_id,
    metadata: { agent_id: agent.id, agent_code: agent.code, command_id: cmd.id },
    actorRoleSnapshot: ctx.platformRole,
  });

  return NextResponse.json({ ok: true, command_id: cmd.id, audit });
}

export async function GET(_req: Request, { params }: RouteContext) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  const { data, error } = await createAdminClient()
    .from("agent_commands")
    .select("id, status, created_at, completed_at, result, error")
    .eq("agent_id", id)
    .eq("type", "collect_diagnostics")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "db_error", message: error.message }, { status: 500 });
  return NextResponse.json({ latest: data ?? null });
}
