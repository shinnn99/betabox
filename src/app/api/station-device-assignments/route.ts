import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermission,
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { invalidateCameraCaches } from "@/lib/camera/service";

export const runtime = "nodejs";

/**
 * GET — list assignment history for a device or for a station.
 * Use ?device_id=... or ?station_id=...
 */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("station_device_assignment.view");
  if (isError(ctx)) return ctx;

  const deviceId = req.nextUrl.searchParams.get("device_id");
  const stationId = req.nextUrl.searchParams.get("station_id");
  if (!deviceId && !stationId) {
    return NextResponse.json(
      { error: "missing_filter", message: "Cần device_id hoặc station_id." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  let q = admin
    .from("station_device_assignments")
    .select(
      `id, device_id, station_id, assigned_at, unassigned_at, status,
       station_devices ( device_code, name, device_type ),
       packing_stations ( code, name )`,
    )
    .eq("organization_id", ctx.organizationId)
    .order("assigned_at", { ascending: false });
  if (deviceId) q = q.eq("device_id", deviceId);
  if (stationId) q = q.eq("station_id", stationId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ assignments: data ?? [] });
}

/**
 * POST — assign a device to a station. If the device already has an active
 * assignment (on the same or different station), close it first with
 * unassigned_at = now() so history is preserved. Then open a new row.
 *
 * Body: { device_id, station_id }
 */
export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("station_device_assignment.manage");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const deviceId = String(body.device_id ?? "").trim();
  const stationId = String(body.station_id ?? "").trim();
  if (!deviceId || !stationId) {
    return NextResponse.json(
      { error: "validation", message: "Cần device_id và station_id." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Verify both belong to caller's org.
  const [{ data: dev }, { data: stn }] = await Promise.all([
    admin
      .from("station_devices")
      .select("id, device_code, device_type, status")
      .eq("id", deviceId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle(),
    admin
      .from("packing_stations")
      .select("id, code, status")
      .eq("id", stationId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle(),
  ]);
  if (!dev) {
    return NextResponse.json(
      { error: "device_not_found" },
      { status: 400 },
    );
  }
  if (!stn) {
    return NextResponse.json(
      { error: "station_not_found" },
      { status: 400 },
    );
  }
  if (dev.status !== "active" || stn.status !== "active") {
    return NextResponse.json(
      {
        error: "inactive_target",
        message: "Thiết bị hoặc bàn đang ở trạng thái lưu trữ.",
      },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();

  // Close any active assignment for THIS device (it can only be active in
  // one place at a time — partial unique index uniq_active_assignment_per_device
  // enforces this).
  //
  // Cross-tenant guard: filter organization_id để attacker biết device_id
  // org khác không thể unassign device đó (dù device_id đã verify org ở
  // trên, giữ filter phòng thủ nhiều-tầng).
  await admin
    .from("station_device_assignments")
    .update({ unassigned_at: now, status: "ended" })
    .eq("organization_id", ctx.organizationId)
    .eq("device_id", deviceId)
    .is("unassigned_at", null);

  // Rule: at most one active device PER (station, device_type). A packing
  // station typically needs both a scanner and a camera, so we only retire
  // the previous assignment that shares the same device_type as the new one.
  //
  // Cross-tenant guard: filter organization_id trước station_id để attacker
  // biết station_id org khác không enumerate được device assignments.
  const { data: stationActive } = await admin
    .from("station_device_assignments")
    .select("id, station_devices!inner ( device_type )")
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", stationId)
    .is("unassigned_at", null);

  const sameTypeIds = ((stationActive ?? []) as Array<{
    id: string;
    station_devices: { device_type: string } | { device_type: string }[] | null;
  }>)
    .filter((r) => {
      const sd = Array.isArray(r.station_devices)
        ? r.station_devices[0]
        : r.station_devices;
      return sd?.device_type === dev.device_type;
    })
    .map((r) => r.id);

  if (sameTypeIds.length > 0) {
    // Cross-tenant guard: sameTypeIds đã lọc org qua stationActive query,
    // nhưng thêm filter phòng thủ để defense-in-depth (nếu tương lai
    // stationActive query bị sửa nhầm bỏ org filter, chỗ này vẫn chặn).
    await admin
      .from("station_device_assignments")
      .update({ unassigned_at: now, status: "ended" })
      .eq("organization_id", ctx.organizationId)
      .in("id", sameTypeIds);
  }

  const { data, error } = await admin
    .from("station_device_assignments")
    .insert({
      organization_id: ctx.organizationId,
      device_id: deviceId,
      station_id: stationId,
      assigned_at: now,
      status: "active",
    })
    .select("id, device_id, station_id, assigned_at, status")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Active assignment changed → the camera↔station map in listCameras
  // cache must be discarded.
  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "station_device_assignment.assign",
    targetType: "station_device_assignment",
    targetId: data.id,
    metadata: { device_id: deviceId, station_id: stationId },
  });

  return NextResponse.json({ assignment: data }, { status: 201 });
}

/**
 * DELETE — unassign the current active assignment of a device (close with
 * unassigned_at = now() but never hard-delete). Body: { device_id }
 */
export async function DELETE(req: Request) {
  const ctx = await requirePermissionStrict("station_device_assignment.manage");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  const deviceId = String(body?.device_id ?? "").trim();
  if (!deviceId) {
    return NextResponse.json(
      { error: "validation", message: "Cần device_id." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("station_device_assignments")
    .update({ unassigned_at: now, status: "ended" })
    .eq("device_id", deviceId)
    .eq("organization_id", ctx.organizationId)
    .is("unassigned_at", null)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "no_active_assignment", message: "Thiết bị không có gán nào đang hoạt động." },
      { status: 400 },
    );
  }

  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "station_device_assignment.unassign",
    targetType: "station_device_assignment",
    targetId: data[0].id,
    metadata: { device_id: deviceId },
  });

  return NextResponse.json({ ok: true });
}
