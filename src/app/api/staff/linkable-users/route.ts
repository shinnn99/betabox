import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";

/**
 * Trả về danh sách user trong cùng org chưa được link với staff nào.
 * Có thể truyền ?include_staff_id=<id> để include user đang link với staff đó (cho dialog edit).
 */
export async function GET(req: Request) {
  const ctx = await requirePermission("staff.invite");
  if (isError(ctx)) return ctx;

  const url = new URL(req.url);
  const includeStaffId = url.searchParams.get("include_staff_id");

  const admin = createAdminClient();

  const { data: profiles } = await admin
    .from("user_profiles")
    .select("id, full_name, role")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "active");

  const { data: linkedStaff } = await admin
    .from("staff_profiles")
    .select("user_id, id")
    .eq("organization_id", ctx.organizationId)
    .not("user_id", "is", null);

  const linkedUserIds = new Set(
    (linkedStaff ?? [])
      .filter((s) => s.id !== includeStaffId)
      .map((s) => s.user_id)
  );

  const candidates = (profiles ?? []).filter((p) => !linkedUserIds.has(p.id));

  // Lấy email
  const result = await Promise.all(
    candidates.map(async (p) => {
      const { data: au } = await admin.auth.admin.getUserById(p.id);
      return {
        id: p.id,
        email: au?.user?.email ?? "",
        full_name: p.full_name,
        role: p.role,
      };
    })
  );

  return NextResponse.json({ users: result });
}
