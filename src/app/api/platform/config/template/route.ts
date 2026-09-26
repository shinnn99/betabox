import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";
import { invalidateTemplateCache, readPlatformTemplate } from "@/lib/config/template-store";
import { TEMPLATE_BOUNDS, parseTemplatePatch } from "@/lib/config/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// /api/platform/config/template — mẫu cấu hình nền tảng (kế hoạch
// VAN-HANH-NHIEU-KHO, đợt 6).
//
// GET  : mẫu đang dùng + khoảng nhận của từng ô + có đang dùng bảng hay dự
//        phòng trong mã (chưa chạy migration).
// PATCH: sửa mẫu. GATE platform_owner. Audit trước / sau.
//
// Sửa mẫu KHÔNG đổi tổ chức / kho nào đang có — mẫu chỉ được chép lúc tạo.
// Riêng `clip_max_seconds` có hiệu lực NGAY cho cả nền tảng (trần clip và
// trần tự dừng đơn đi), trong vòng 60 giây đệm.
// ============================================================================

export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;
  const read = await readPlatformTemplate(createAdminClient(), { fresh: true });
  return NextResponse.json({ ...read, bounds: TEMPLATE_BOUNDS, canEdit: ctx.platformRole === "platform_owner" });
}

export async function PATCH(req: Request) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = parseTemplatePatch(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: "validation", message: parsed.message }, { status: 400 });

  const admin = createAdminClient();
  const before = await readPlatformTemplate(admin, { fresh: true });
  if (!before.fromTable) {
    // Không có bảng thì không có chỗ ghi — nói thẳng, đừng giả vờ đã lưu.
    return NextResponse.json({ error: "template_unavailable", message: before.reason }, { status: 503 });
  }

  const { error } = await admin
    .from("platform_config_template")
    .update({ ...parsed.update, updated_at: new Date().toISOString(), updated_by: ctx.userId })
    .eq("id", 1);
  if (error) return NextResponse.json({ error: "db_error", message: error.message }, { status: 400 });

  invalidateTemplateCache();
  const after = await readPlatformTemplate(admin, { fresh: true });

  const keys = Object.keys(parsed.update) as Array<keyof typeof parsed.update>;
  const audit = await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: null,
    action: "platform.config_template.update",
    targetType: "platform_config_template",
    targetId: null,
    metadata: {
      before: Object.fromEntries(keys.map((k) => [k, before.template[k]])),
      after: Object.fromEntries(keys.map((k) => [k, after.template[k]])),
    },
    actorRoleSnapshot: ctx.platformRole,
  });

  return NextResponse.json({ ok: true, ...after, audit });
}
