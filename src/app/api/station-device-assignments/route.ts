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
      .select("id, device_code, device_type, status, name, config_json")
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
  const { error: devCloseErr } = await admin
    .from("station_device_assignments")
    .update({ unassigned_at: now, status: "ended" })
    .eq("organization_id", ctx.organizationId)
    .eq("device_id", deviceId)
    .is("unassigned_at", null);
  if (devCloseErr) {
    return NextResponse.json(
      {
        error: "assignment_close_previous_failed",
        message: devCloseErr.message,
      },
      { status: 500 },
    );
  }

  // Slot uniqueness is role-aware: a station can have one overview camera,
  // one QR camera, one physical scanner and one qrcam virtual scanner.
  //
  // Cross-tenant guard: filter organization_id trước station_id để attacker
  // biết station_id org khác không enumerate được device assignments.
  const { data: stationActive, error: stationActiveErr } = await admin
    .from("station_device_assignments")
    .select("id, device_id, station_devices!inner ( device_type, device_code, config_json )")
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", stationId)
    .is("unassigned_at", null);
  if (stationActiveErr) {
    return NextResponse.json(
      {
        error: "station_active_lookup_failed",
        message: stationActiveErr.message,
      },
      { status: 500 },
    );
  }

  const sameTypeIds = ((stationActive ?? []) as Array<{
    id: string;
    device_id: string;
    station_devices: { device_type: string; device_code: string; config_json: Record<string, unknown> | null } | Array<{ device_type: string; device_code: string; config_json: Record<string, unknown> | null }> | null;
  }>)
    .filter((r) => {
      const sd = Array.isArray(r.station_devices)
        ? r.station_devices[0]
        : r.station_devices;
      if (!sd || r.device_id === deviceId || sd.device_type !== dev.device_type) return false;
      if (dev.device_type === "camera") {
        return String(sd.config_json?.role ?? "proof_primary") === String(dev.config_json?.role ?? "proof_primary");
      }
      if (dev.device_type === "scanner") {
        return sd.device_code.toLowerCase().startsWith("qrcam_") === dev.device_code.toLowerCase().startsWith("qrcam_");
      }
      return true;
    })
    .map((r) => r.id);

  if (sameTypeIds.length > 0) {
    // Cross-tenant guard: sameTypeIds đã lọc org qua stationActive query,
    // nhưng thêm filter phòng thủ để defense-in-depth (nếu tương lai
    // stationActive query bị sửa nhầm bỏ org filter, chỗ này vẫn chặn).
    const { error: sameTypeErr } = await admin
      .from("station_device_assignments")
      .update({ unassigned_at: now, status: "ended" })
      .eq("organization_id", ctx.organizationId)
      .in("id", sameTypeIds);
    if (sameTypeErr) {
      return NextResponse.json(
        {
          error: "assignment_close_sametype_failed",
          message: sameTypeErr.message,
        },
        { status: 500 },
      );
    }
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

  // A QR camera participates in the existing scanner resolver through a
  // virtual scanner device. Keep the physical scanner assignment intact so
  // admins can switch scan_source without rewiring devices.
  if (dev.device_type === "camera" && String(dev.config_json?.role) === "proof_qr") {
    const cameraId = String(dev.config_json?.camera_id ?? "");
    const { data: camera } = await admin
      .from("cameras")
      .select("camera_code")
      .eq("organization_id", ctx.organizationId)
      .eq("id", cameraId)
      .maybeSingle();
    if (!camera) {
      return NextResponse.json({ error: "camera_not_found" }, { status: 409 });
    }
    const virtualCode = `qrcam_${camera.camera_code}`.toLowerCase();
    const { data: existingVirtual, error: virtualLookupErr } = await admin
      .from("station_devices")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("device_code", virtualCode)
      .maybeSingle();
    if (virtualLookupErr) {
      return NextResponse.json({ error: "virtual_scanner_lookup_failed", message: virtualLookupErr.message }, { status: 500 });
    }
    let virtualId = existingVirtual?.id as string | undefined;
    if (!virtualId) {
      const { data: virtual, error: virtualCreateErr } = await admin
        .from("station_devices")
        .insert({
          organization_id: ctx.organizationId,
          device_code: virtualCode,
          device_type: "scanner",
          name: `QR camera ${dev.name}`,
          status: "active",
          connection_type: "unknown",
          config_json: { virtual_source: "camera_qr", camera_id: cameraId },
        })
        .select("id")
        .single();
      if (virtualCreateErr || !virtual) {
        return NextResponse.json({ error: "virtual_scanner_create_failed", message: virtualCreateErr?.message }, { status: 500 });
      }
      virtualId = virtual.id;
    }
    const { error: virtualCloseErr } = await admin
      .from("station_device_assignments")
      .update({ unassigned_at: now, status: "ended" })
      .eq("organization_id", ctx.organizationId)
      .eq("device_id", virtualId)
      .is("unassigned_at", null);
    if (virtualCloseErr) {
      return NextResponse.json({ error: "virtual_scanner_move_failed", message: virtualCloseErr.message }, { status: 500 });
    }
    const { error: virtualAssignErr } = await admin
      .from("station_device_assignments")
      .insert({ organization_id: ctx.organizationId, device_id: virtualId, station_id: stationId, assigned_at: now, status: "active" });
    if (virtualAssignErr) {
      return NextResponse.json({ error: "virtual_scanner_assign_failed", message: virtualAssignErr.message }, { status: 500 });
    }
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
