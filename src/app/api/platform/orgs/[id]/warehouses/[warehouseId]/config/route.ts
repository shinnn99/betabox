import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";
import { editWarehouseConfig } from "@/lib/platform/config-edit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string; warehouseId: string }>;
}

// ============================================================================
// PATCH /api/platform/orgs/[id]/warehouses/[warehouseId]/config — sửa thông
// số thời gian của một kho từ platform (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
//
// Kho phải thuộc đúng tổ chức trên đường dẫn (kiểm trong editWarehouseConfig).
// GATE: platform_owner — cùng mức với sửa hạn lưu.
// ============================================================================
export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const { id: orgId, warehouseId } = await params;
  const body = await req.json().catch(() => null);

  const admin = createAdminClient();
  const result = await editWarehouseConfig(admin, orgId, warehouseId, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }

  const { data: org } = await admin.from("organizations").select("name").eq("id", orgId).maybeSingle();

  // targetId là TỔ CHỨC chứ không phải kho: trang chi tiết tổ chức lọc nhật
  // ký platform theo `target_id = org` — ghi id kho thì việc sửa hộ không
  // hiện ở đó. Kho nằm trong metadata.
  const audit = await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: null,
    action: "platform.warehouse.config.update",
    targetType: "organization",
    targetId: orgId,
    metadata: {
      warehouse_id: warehouseId,
      warehouse_code: result.warehouseCode ?? null,
      before: result.before,
      after: result.after,
    },
    actorRoleSnapshot: ctx.platformRole,
    targetOrganizationNameSnapshot: (org?.name as string | undefined) ?? null,
  });

  return NextResponse.json({ ok: true, params: result.params, before: result.before, after: result.after, audit });
}
