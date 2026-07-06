import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";

// ============================================================================
// GET /api/session-context — trả effective session context cho client.
//
// Dùng cho useSession client-side: khi user là platform admin đang impersonate,
// JWT client-side không có organization_id (platform không có org). Client phải
// đọc effective ctx từ server (qua guard 3 lớp) để biết org đang impersonate.
//
// Logic: gọi requirePermission với permission bất kỳ tenant có (ví dụ
// "warehouse.view" — 6 roles đều có) để guard chạy đủ 3 lớp và trả ApiContext.
// Nếu user không có permission (edge case) → fallback trả JWT thô.
// ============================================================================
export async function GET() {
  // requirePermission chạy readClaims → 3 lớp → trả ApiContext (org từ token
  // nếu impersonate, hoặc org từ JWT nếu tenant thường).
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) {
    // Nếu không có permission (user role thấp), thử permission phổ biến hơn
    const ctx2 = await requirePermission("staff.view");
    if (isError(ctx2)) {
      return NextResponse.json({ error: "context_unavailable" }, { status: 403 });
    }
    return buildContextResponse(ctx2);
  }
  return buildContextResponse(ctx);
}

async function buildContextResponse(ctx: {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
  isPlatform: boolean;
  impersonatingOrgId?: string;
}): Promise<NextResponse> {
  // Enrich org name + user_profiles (giống useSession client)
  const admin = createAdminClient();

  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", ctx.organizationId)
    .maybeSingle();

  // user_profiles: nếu impersonate thì betabox không có row → dùng email làm fullName
  let fullName = ctx.email;
  let phone: string | null = null;
  if (!ctx.isPlatform) {
    const { data: profile } = await admin
      .from("user_profiles")
      .select("full_name, phone")
      .eq("id", ctx.userId)
      .maybeSingle();
    if (profile) {
      fullName = profile.full_name ?? ctx.email;
      phone = profile.phone;
    }
  }

  return NextResponse.json({
    userId: ctx.userId,
    email: ctx.email,
    fullName,
    role: ctx.role,
    organizationId: ctx.organizationId,
    organizationName: org?.name ?? "",
    phone,
    isPlatform: ctx.isPlatform,
    impersonatingOrgId: ctx.impersonatingOrgId ?? null,
  });
}
