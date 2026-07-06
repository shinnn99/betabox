import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { invalidateCameraCaches } from "@/lib/camera/service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("packing_station.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") update.name = body.name.trim();
  if (typeof body.code === "string") update.code = body.code.trim().toUpperCase();
  if (typeof body.status === "string") update.status = body.status;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("packing_stations")
    .update(update)
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (error) {
    const msg =
      (error as { code?: string }).code === "23505"
        ? "Mã bàn đã tồn tại trong kho này."
        : error.message;
    return NextResponse.json({ error: error.code ?? "update_failed", message: msg }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "packing_station.update",
    targetType: "packing_station",
    targetId: id,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true });
}

/**
 * Archive (soft-delete) — we don't hard-delete stations because past
 * staff_work_sessions / packing_events reference them via FK. The dashboard
 * filters out archived rows where appropriate.
 */
export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("packing_station.archive");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();

  // Cross-tenant guard: verify station thuộc org trước mọi tác động
  // cascade. Nếu attacker gửi station_id org khác, refuse 404 SỚM —
  // không cascade sang staff_work_sessions/station_device_assignments
  // org khác. Update packing_stations dưới cũng có org filter (defense-
  // in-depth), nhưng verify trước tránh cascade oan.
  const { data: stationOwn } = await admin
    .from("packing_stations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (!stationOwn) {
    return NextResponse.json(
      { error: "not_found", message: "Không tìm thấy bàn." },
      { status: 404 },
    );
  }

  // Refuse if station has an active work session — operator should end it
  // first. Otherwise archiving silently breaks the live dashboard.
  const { count: activeSessions } = await admin
    .from("staff_work_sessions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", id)
    .eq("status", "active");
  if ((activeSessions ?? 0) > 0) {
    return NextResponse.json(
      {
        error: "station_in_use",
        message: "Bàn đang có phiên hoạt động, hãy kết thúc phiên trước khi lưu trữ.",
      },
      { status: 400 },
    );
  }

  // Close any active device assignment pointing at this station.
  await admin
    .from("station_device_assignments")
    .update({
      unassigned_at: new Date().toISOString(),
      status: "ended",
    })
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", id)
    .is("unassigned_at", null);

  const { error } = await admin
    .from("packing_stations")
    .update({ status: "archived" })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Closed any active camera↔station assignment pointing at this
  // station above. Drop the camera service cache so the next list
  // reflects the cleared mapping.
  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "packing_station.archive",
    targetType: "packing_station",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
