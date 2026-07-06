import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { getScopedClient } from "@/lib/supabase/scoped-client";
import { audit } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const scoped = await getScopedClient(ctx);
  const { data, error } = await scoped
    .select("warehouses", "id, code, name, address, status, session_fallback_seconds, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ warehouse: data });
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("warehouse.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") update.name = body.name.trim();
  if (typeof body.code === "string") update.code = body.code.trim().toUpperCase();
  if (typeof body.address === "string" || body.address === null) update.address = body.address;
  if (typeof body.status === "string") update.status = body.status;
  if (typeof body.session_fallback_seconds === "number" && body.session_fallback_seconds > 0) {
    update.session_fallback_seconds = Math.floor(body.session_fallback_seconds);
  }

  // packing_timing_config: chỉ nhận 3 field UI, clamp theo ngưỡng an toàn
  // (cùng cận với clip-resolver để config không tạo clip vượt trần cứng).
  // Merge JSONB — giữ nguyên các key khác (kỹ thuật, không expose UI).
  const timingIn =
    body.packing_timing_config && typeof body.packing_timing_config === "object"
      ? (body.packing_timing_config as Record<string, unknown>)
      : null;
  let timingPatch: Record<string, number> | null = null;
  if (timingIn) {
    const patch: Record<string, number> = {};
    const clamp = (v: unknown, min: number, max: number): number | null => {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      const n = Math.floor(v);
      if (n < min) return min;
      if (n > max) return max;
      return n;
    };
    const mo = clamp(timingIn.max_order_seconds, 60, 3600);
    const vp = clamp(timingIn.video_pre_seconds, 0, 120);
    const vpost = clamp(timingIn.video_default_post_seconds, 1, 600);
    if (mo !== null) patch.max_order_seconds = mo;
    if (vp !== null) patch.video_pre_seconds = vp;
    if (vpost !== null) patch.video_default_post_seconds = vpost;
    if (Object.keys(patch).length > 0) timingPatch = patch;
  }

  const admin = createAdminClient();
  if (timingPatch) {
    // Đọc config hiện tại rồi merge — giữ key không đụng (timing_strategy,
    // stale_session_hours, ...). Chạy trong cùng request là đủ vì không có
    // ghi concurrent thực tế trên bảng warehouses.
    const { data: cur } = await admin
      .from("warehouses")
      .select("packing_timing_config")
      .eq("id", id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    const curCfg =
      (cur?.packing_timing_config as Record<string, unknown> | null) ?? {};
    update.packing_timing_config = { ...curCfg, ...timingPatch };
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "empty_update" }, { status: 400 });
  }

  const { error } = await admin
    .from("warehouses")
    .update(update)
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "warehouse.update",
    targetType: "warehouse",
    targetId: id,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("warehouse.delete");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();
  const { error } = await admin
    .from("warehouses")
    .delete()
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "warehouse.delete",
    targetType: "warehouse",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
