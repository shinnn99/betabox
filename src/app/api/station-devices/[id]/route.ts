import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { invalidateCameraCaches } from "@/lib/camera/service";
import { validateCameraConfig } from "../route";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

const VALID_TYPES = ["scanner", "camera", "printer", "scale"];

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("station_device.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") update.name = body.name.trim();
  if (typeof body.device_code === "string")
    update.device_code = body.device_code.trim().toUpperCase();
  if (typeof body.device_type === "string") {
    if (!VALID_TYPES.includes(body.device_type)) {
      return NextResponse.json(
        { error: "validation", message: "Loại thiết bị không hợp lệ." },
        { status: 400 },
      );
    }
    update.device_type = body.device_type;
  }
  if (body.config_json && typeof body.config_json === "object")
    update.config_json = body.config_json;
  if (typeof body.status === "string") update.status = body.status;

  // Scanner identity pairing. device_identity is jsonb storing the physical
  // USB signature we use to recognise this scanner regardless of which COM
  // port it lands on. connection_type is one of 'serial'|'hid_keyboard'|
  // 'manual'|'unknown'. We don't validate identity field-by-field — the
  // agent owns the schema and we just store what it gives us.
  if (body.device_identity && typeof body.device_identity === "object") {
    update.device_identity = body.device_identity;
  }
  if (typeof body.connection_type === "string") {
    const ct = body.connection_type.trim();
    if (!["serial", "hid_keyboard", "manual", "unknown"].includes(ct)) {
      return NextResponse.json(
        { error: "validation", message: "connection_type không hợp lệ." },
        { status: 400 },
      );
    }
    update.connection_type = ct;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  // If we're updating to (or staying on) device_type='camera' AND
  // config_json is being touched, re-validate the camera_id link.
  const admin = createAdminClient();
  if (update.config_json) {
    const { data: cur } = await admin
      .from("station_devices")
      .select("device_type")
      .eq("id", id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    const effectiveType = (update.device_type as string) ?? cur?.device_type;
    if (effectiveType === "camera") {
      const err = await validateCameraConfig(
        ctx.organizationId,
        update.config_json as Record<string, unknown>,
        id,
      );
      if (err) return err;
    }
  }
  const { error } = await admin
    .from("station_devices")
    .update(update)
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (error) {
    const msg =
      (error as { code?: string }).code === "23505"
        ? "Mã thiết bị đã tồn tại."
        : error.message;
    return NextResponse.json({ error: error.code ?? "update_failed", message: msg }, { status: 400 });
  }

  // device_code / config_json / status changes can shift the camera
  // soft-link join — invalidate so listCameras() re-reads.
  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "station_device.update",
    targetType: "station_device",
    targetId: id,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("station_device.archive");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();

  // Close current assignment if any.
  await admin
    .from("station_device_assignments")
    .update({
      unassigned_at: new Date().toISOString(),
      status: "ended",
    })
    .eq("device_id", id)
    .is("unassigned_at", null);

  const { error } = await admin
    .from("station_devices")
    .update({ status: "archived" })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Archived devices drop out of the soft-link join (the query filters
  // .neq("status", "archived")); also closed any active assignment
  // above, which removes the current_station mapping.
  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "station_device.archive",
    targetType: "station_device",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
