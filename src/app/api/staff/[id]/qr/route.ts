import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { issueAndStoreStaffQr } from "@/lib/qr";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST = cấp QR mới (cấp lại — revoke cái cũ).
 * Sau migration `staff_qr_credentials.payload`, raw payload luôn lưu trong DB,
 * không còn ràng buộc "chỉ hiện 1 lần" — list endpoint trả `qr_payload` để UI render lại.
 */
export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("staff.qr.regenerate");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, organization_id, staff_code")
    .eq("id", id)
    .single();
  if (!staff || staff.organization_id !== ctx.organizationId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let issued;
  try {
    issued = await issueAndStoreStaffQr(ctx.organizationId, id, ctx.userId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "staff.qr.regenerate",
    targetType: "staff",
    targetId: id,
    metadata: { staff_code: staff.staff_code, token_prefix: issued.tokenPrefix },
  });

  return NextResponse.json({
    payload: issued.payload,
    png_data_url: issued.pngDataUrl,
    token_prefix: issued.tokenPrefix,
  });
}
