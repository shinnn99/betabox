import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ============================================================================
// DELETE /api/platform/admins/[id] — xóa/revoke platform admin
// GATE: platform_owner. Chặn tự xóa mình (kill-switch bảo vệ).
// ============================================================================
export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  // Chặn tự xóa mình (owner cuối cùng không thể xóa mình = kẹt hệ)
  if (id === ctx.userId) {
    return NextResponse.json(
      {
        error: "self_delete_forbidden",
        message: "Không thể tự xóa quyền platform admin của mình.",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: target } = await admin
    .from("platform_admins")
    .select("id, role")
    .eq("id", id)
    .maybeSingle();
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Đếm platform_owner active còn lại — chặn xóa nếu là owner cuối cùng
  if (target.role === "platform_owner") {
    const { count: ownerCount } = await admin
      .from("platform_admins")
      .select("id", { count: "exact", head: true })
      .eq("role", "platform_owner")
      .eq("status", "active");
    if ((ownerCount ?? 0) <= 1) {
      return NextResponse.json(
        {
          error: "last_owner",
          message: "Không thể xóa platform_owner cuối cùng.",
        },
        { status: 400 }
      );
    }
  }

  const { error: delErr } = await admin
    .from("platform_admins")
    .delete()
    .eq("id", id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  // Audit qua helper — destruct .error đúng. Không fail-closed vì DELETE
  // đã ổn.
  await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: null,
    action: "platform.admin.remove",
    targetType: "platform_admin",
    targetId: id,
    metadata: { revoked_role: target.role },
  });

  return NextResponse.json({ ok: true });
}
