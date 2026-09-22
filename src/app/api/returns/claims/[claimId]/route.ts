import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ claimId: string }>;
}

/**
 * Cập nhật hồ sơ kiện hoàn.
 *
 * Chỉ hai chiều người dùng được đi: "Đã khiếu nại" và "Không cần". Hết hạn
 * là việc của hệ thống (`expire_return_claims`), không cho bấm tay — nếu
 * không thì một hồ sơ có thể bị đóng sớm và mất dấu vết vì sao.
 */
export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("order_proof.view", req);
  if (isError(ctx)) return ctx;
  const { claimId } = await params;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const rec = body as Record<string, unknown>;

  const update: Record<string, unknown> = { updated_by: ctx.userId };
  if (rec.status !== undefined) {
    if (rec.status !== "submitted" && rec.status !== "dismissed") {
      return NextResponse.json(
        { error: "invalid_status", message: "Chỉ đổi được sang 'submitted' hoặc 'dismissed'." },
        { status: 400 },
      );
    }
    update.status = rec.status;
  }
  if (typeof rec.platform_claim_ref === "string") {
    update.platform_claim_ref = rec.platform_claim_ref.trim() || null;
  }
  if (typeof rec.note === "string") {
    update.note = rec.note.trim() || null;
  }
  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("return_claims")
    .update(update)
    .eq("id", claimId)
    .eq("organization_id", ctx.organizationId)
    // Hồ sơ đã tới trạng thái cuối thì không sửa ngược được.
    .in("status", ["open", "submitted"])
    .select("id, status, packing_event_id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "update_failed", message: error.message }, { status: 400 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "not_updatable", message: "Hồ sơ không tồn tại hoặc đã kết thúc." },
      { status: 409 },
    );
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "return_claim.update",
    targetType: "return_claim",
    targetId: claimId,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true, claim: data });
}
