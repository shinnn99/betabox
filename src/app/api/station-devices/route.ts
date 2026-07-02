import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermission,
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { invalidateCameraCaches } from "@/lib/camera/service";

export const runtime = "nodejs";

const VALID_TYPES = ["scanner", "camera", "printer", "scale"] as const;
type DeviceType = (typeof VALID_TYPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Camera devices use config_json = { camera_id, role?: "proof_primary" }.
 * We check: shape valid, camera exists in this org, and no OTHER active
 * station_device already references this same camera_id. Returns a
 * NextResponse on failure or null on pass.
 *
 * @param excludeDeviceId — when updating, pass the row id being edited
 *   so the "already claimed" check doesn't flag the row against itself.
 */
export async function validateCameraConfig(
  organizationId: string,
  configJson: Record<string, unknown>,
  excludeDeviceId?: string,
): Promise<NextResponse | null> {
  const cameraId = String(configJson.camera_id ?? "").trim();
  if (!cameraId || !UUID_RE.test(cameraId)) {
    return NextResponse.json(
      {
        error: "validation",
        message:
          "Camera device cần config_json.camera_id là UUID hợp lệ.",
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: cam } = await admin
    .from("cameras")
    .select("id")
    .eq("id", cameraId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!cam) {
    return NextResponse.json(
      {
        error: "validation",
        message: "Camera không tồn tại trong tổ chức này.",
      },
      { status: 400 },
    );
  }

  // Look for OTHER active station_devices already pointing to this camera.
  // We have to fetch + filter in JS because PostgREST can't query inside
  // jsonb with eq() reliably across versions.
  const { data: existingRows } = await admin
    .from("station_devices")
    .select("id, device_code, config_json, status")
    .eq("organization_id", organizationId)
    .eq("device_type", "camera")
    .neq("status", "archived");
  for (const r of (existingRows ?? []) as Array<{
    id: string;
    device_code: string;
    config_json: Record<string, unknown> | null;
  }>) {
    if (excludeDeviceId && r.id === excludeDeviceId) continue;
    if (String(r.config_json?.camera_id ?? "") === cameraId) {
      return NextResponse.json(
        {
          error: "camera_already_claimed",
          message: `Camera đã được gán vào thiết bị "${r.device_code}". Gỡ trước khi gán lại.`,
        },
        { status: 409 },
      );
    }
  }

  return null;
}

interface AssignmentJoin {
  station_id: string;
  packing_stations: { code: string; name: string; warehouse_id: string } | { code: string; name: string; warehouse_id: string }[] | null;
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("station_device.view");
  if (isError(ctx)) return ctx;

  const deviceType = req.nextUrl.searchParams.get("device_type");
  const supabase = await createClient();
  let q = supabase
    .from("station_devices")
    .select(
      "id, device_code, device_type, name, config_json, status, created_at, updated_at, connection_type, device_identity, current_port, connection_status, last_seen_at, last_error, bound_agent_id",
    )
    .order("device_code");
  if (deviceType) q = q.eq("device_type", deviceType);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Annotate each device with its current assignment (if any) so the UI can
  // show "Bàn 01" next to each scanner without a follow-up call.
  const admin = createAdminClient();
  const { data: assigns } = await admin
    .from("station_device_assignments")
    .select("device_id, station_id, assigned_at, packing_stations ( code, name, warehouse_id )")
    .eq("organization_id", ctx.organizationId)
    .is("unassigned_at", null);

  const byDevice = new Map<string, AssignmentJoin & { device_id: string; assigned_at: string }>();
  for (const a of (assigns ?? []) as Array<AssignmentJoin & { device_id: string; assigned_at: string }>) {
    byDevice.set(a.device_id, a);
  }

  const devices = (data ?? []).map((d) => {
    const a = byDevice.get(d.id);
    const ps = a ? (Array.isArray(a.packing_stations) ? a.packing_stations[0] : a.packing_stations) : null;
    return {
      ...d,
      current_station: a && ps
        ? {
            station_id: a.station_id,
            station_code: ps.code,
            station_name: ps.name,
            warehouse_id: ps.warehouse_id,
            assigned_at: a.assigned_at,
          }
        : null,
    };
  });

  return NextResponse.json({ devices });
}

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("station_device.create");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const deviceCode = String(body.device_code ?? "").trim().toUpperCase();
  const deviceType = String(body.device_type ?? "").trim();
  const name = String(body.name ?? "").trim();
  const configJson =
    body.config_json && typeof body.config_json === "object" ? body.config_json : {};

  if (!deviceCode || !name) {
    return NextResponse.json(
      { error: "validation", message: "Mã thiết bị và tên là bắt buộc." },
      { status: 400 },
    );
  }
  if (!VALID_TYPES.includes(deviceType as DeviceType)) {
    return NextResponse.json(
      { error: "validation", message: "Loại thiết bị không hợp lệ." },
      { status: 400 },
    );
  }

  // Camera devices require a real camera_id pointing to a row in
  // public.cameras of the same org, and that camera must not already
  // be claimed by another active station_device. This keeps the
  // "1 camera = 1 station device" invariant intact at the API layer
  // (the DB doesn't enforce it because config_json is jsonb).
  if (deviceType === "camera") {
    const cameraErr = await validateCameraConfig(ctx.organizationId, configJson);
    if (cameraErr) return cameraErr;
  }

  const admin = createAdminClient();

  const insertRow: Record<string, unknown> = {
    organization_id: ctx.organizationId,
    device_code: deviceCode,
    device_type: deviceType,
    name,
    config_json: configJson,
  };
  if (body.device_identity && typeof body.device_identity === "object") {
    insertRow.device_identity = body.device_identity;
  }
  if (typeof body.connection_type === "string") {
    const ct = body.connection_type.trim();
    if (["serial", "hid_keyboard", "manual", "unknown"].includes(ct)) {
      insertRow.connection_type = ct;
    }
  }

  const { data, error } = await admin
    .from("station_devices")
    .insert(insertRow)
    .select(
      "id, device_code, device_type, name, config_json, status, created_at, updated_at, connection_type, device_identity, current_port, connection_status, last_seen_at",
    )
    .single();

  if (error) {
    const msg =
      (error as { code?: string }).code === "23505"
        ? "Mã thiết bị đã tồn tại trong tổ chức này."
        : error.message;
    return NextResponse.json({ error: error.code ?? "insert_failed", message: msg }, { status: 400 });
  }

  // station_devices is part of the camera↔station soft-link join cached
  // by listCameras(); invalidate so the next list shows the new row.
  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "station_device.create",
    targetType: "station_device",
    targetId: data.id,
    metadata: { device_code: deviceCode, device_type: deviceType },
  });

  return NextResponse.json({ device: data }, { status: 201 });
}
