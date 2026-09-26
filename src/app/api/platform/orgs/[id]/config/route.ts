import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";
import { editOrgConfig } from "@/lib/platform/config-edit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ============================================================================
// PATCH /api/platform/orgs/[id]/config — sửa hạn lưu của một tổ chức từ
// platform, không cần đóng giả (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
//
// GATE: platform_owner. Hạ hạn lưu là video cũ bị xoá sớm hơn ở máy kho —
// mất bằng chứng không lấy lại được — nên không mở cho platform_support.
// ============================================================================
export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const { id: orgId } = await params;
  const body = await req.json().catch(() => null);

  const admin = createAdminClient();
  const result = await editOrgConfig(admin, orgId, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }

  // Ghi SAU khi sửa thành công. Audit hỏng thì vẫn trả kết quả — việc sửa đã
  // xảy ra, giấu đi còn tệ hơn — nhưng nói rõ để giao diện báo người sửa.
  const audit = await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: null,
    action: "platform.org.config.update",
    targetType: "organization",
    targetId: orgId,
    metadata: { before: result.before, after: result.after },
    actorRoleSnapshot: ctx.platformRole,
    targetOrganizationNameSnapshot: result.orgName ?? null,
  });

  return NextResponse.json({ ok: true, params: result.params, before: result.before, after: result.after, audit });
}
