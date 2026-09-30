import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrganizationContext, isError } from "@/lib/supabase/guard";

// ============================================================================
// GET /api/session-context — trả effective session context cho client.
//
// Dùng cho useSession client-side: khi user là platform admin đang impersonate,
// JWT client-side không có organization_id (platform không có org). Client phải
// đọc effective ctx từ server (qua guard 3 lớp) để biết org đang impersonate.
//
// Không mượn một quyền nghiệp vụ làm cửa xác thực: ma trận được chỉnh thủ
// công nên không có mã nào chắc chắn mọi vai trò đều giữ. Route này chỉ trả
// ngữ cảnh phiên; API nghiệp vụ vẫn tự kiểm permission riêng.
// ============================================================================
export async function GET(req: Request) {
  const ctx = await requireOrganizationContext(req);
  if (isError(ctx)) return ctx;
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
