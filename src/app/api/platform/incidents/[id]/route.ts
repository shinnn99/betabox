import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";
import { INCIDENT_ACTIONS, transitionIncident, type IncidentAction } from "@/lib/system/incident-actions";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ============================================================================
// PATCH /api/platform/incidents/[id]  body: { action: "acknowledge" | "resolve" }
// — hai nút của người trực (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
//
// GATE: platform_support — người trực là người nhận việc, không cần quyền
// chủ. Không thao tác nào ở đây làm mất dữ liệu: đóng tay một lỗi còn đang
// xảy ra thì lượt tự kiểm kế tiếp mở dòng mới.
// ============================================================================
export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;
  if (typeof action !== "string" || !INCIDENT_ACTIONS.includes(action as IncidentAction)) {
    return NextResponse.json(
      { error: "validation", message: 'action phải là "acknowledge" hoặc "resolve".' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const result = await transitionIncident(admin, id, action as IncidentAction, ctx.userId, new Date());
  if (!result.ok) {
    return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  }

  const inc = result.incident;
  const orgName = inc.organization_id
    ? (((await admin.from("organizations").select("name").eq("id", inc.organization_id).maybeSingle()).data
        ?.name as string | undefined) ?? null)
    : null;
  const audit = await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: null,
    action: `platform.incident.${action}`,
    // Như sửa cấu hình: gắn vào TỔ CHỨC để hiện ở trang chi tiết tổ chức;
    // sự cố cấp hệ thống thì gắn vào chính sự cố.
    targetType: inc.organization_id ? "organization" : "incident",
    targetId: inc.organization_id ?? inc.id,
    metadata: {
      incident_id: inc.id,
      issue_key: inc.issue_key,
      severity: inc.severity,
      where: inc.where_label,
      what: inc.what_label,
    },
    actorRoleSnapshot: ctx.platformRole,
    targetOrganizationNameSnapshot: orgName,
  });

  return NextResponse.json({ ok: true, incident: inc, audit });
}
