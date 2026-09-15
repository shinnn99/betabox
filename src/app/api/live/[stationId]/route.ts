import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import {
  buildWhepUrl,
  relayPathName,
  resolveStationLiveScope,
  type StationCameraRole,
} from "@/lib/live/station-streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ stationId: string }>;
}

interface AssignedDeviceRow {
  device_id: string;
  station_devices:
    | {
        id: string;
        name: string;
        status: string;
        config_json: Record<string, unknown> | null;
      }
    | Array<{
        id: string;
        name: string;
        status: string;
        config_json: Record<string, unknown> | null;
      }>
    | null;
}

const DEFAULT_WEBRTC_BASE = "http://127.0.0.1:8889";

export async function GET(_request: Request, context: RouteContext) {
  let ctx = await requirePermission("warehouse.view");
  if (isError(ctx) && ctx.status === 403) {
    ctx = await requirePermission("live.view_station");
  }
  if (isError(ctx)) return ctx;

  const { stationId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(stationId)) {
    return NextResponse.json({ error: "station_id_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: station, error: stationError } = await admin
    .from("packing_stations")
    .select("id, code, name, status")
    .eq("id", stationId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (stationError) {
    return NextResponse.json(
      { error: "station_lookup_failed", message: stationError.message },
      { status: 500 },
    );
  }
  if (!station || station.status !== "active") {
    return NextResponse.json({ error: "station_not_found" }, { status: 404 });
  }

  let assignedStationId: string | null = null;
  if (!ctx.isPlatform && ctx.role === "packer") {
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .select("station_id")
      .eq("id", ctx.userId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (profileError) {
      return NextResponse.json(
        {
          error: "station_assignment_unavailable",
          message: "Chưa áp dụng schema gán tài khoản vào bàn đóng hàng.",
        },
        { status: 409 },
      );
    }
    assignedStationId = profile?.station_id ?? null;
  }

  const scope = resolveStationLiveScope({
    role: ctx.role,
    isPlatform: ctx.isPlatform,
    requestedStationId: stationId,
    assignedStationId,
  });
  if (scope === "forbidden") {
    return NextResponse.json(
      { error: "station_live_forbidden" },
      { status: 403 },
    );
  }

  const { data: assignedRows, error: assignmentError } = await admin
    .from("station_device_assignments")
    .select(
      "device_id, station_devices!inner(id, name, status, config_json)",
    )
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", stationId)
    .is("unassigned_at", null)
    .order("assigned_at", { ascending: false });
  if (assignmentError) {
    return NextResponse.json(
      { error: "camera_assignment_lookup_failed", message: assignmentError.message },
      { status: 500 },
    );
  }

  const cameraIdByRole = new Map<StationCameraRole, string>();
  for (const row of (assignedRows ?? []) as AssignedDeviceRow[]) {
    const device = Array.isArray(row.station_devices)
      ? row.station_devices[0]
      : row.station_devices;
    if (!device || device.status === "archived") continue;
    const cameraId = String(device.config_json?.camera_id ?? "");
    const role = device.config_json?.role;
    if (!cameraId || (role !== "proof_primary" && role !== "proof_qr")) continue;
    if (!cameraIdByRole.has(role)) cameraIdByRole.set(role, cameraId);
  }

  const cameraIds = [...new Set(cameraIdByRole.values())];
  const { data: cameras, error: cameraError } = cameraIds.length
    ? await admin
        .from("cameras")
        .select("id, camera_code, name, status")
        .eq("organization_id", ctx.organizationId)
        .in("id", cameraIds)
    : { data: [], error: null };
  if (cameraError) {
    return NextResponse.json(
      { error: "camera_lookup_failed", message: cameraError.message },
      { status: 500 },
    );
  }

  const cameraById = new Map((cameras ?? []).map((camera) => [camera.id, camera]));
  const webRtcBase = process.env.STATION_MEDIAMTX_WEBRTC_BASE_URL ?? DEFAULT_WEBRTC_BASE;
  const cameraForRole = (role: StationCameraRole) => {
    const cameraId = cameraIdByRole.get(role);
    const camera = cameraId ? cameraById.get(cameraId) : null;
    if (!camera) return null;
    const pathName = relayPathName(camera.camera_code, "main");
    return {
      id: camera.id,
      code: camera.camera_code,
      name: camera.name,
      role,
      online: camera.status === "active",
      path_name: pathName,
      whep_url: buildWhepUrl(webRtcBase, pathName),
    };
  };

  return NextResponse.json({
    station: { id: station.id, code: station.code, name: station.name },
    viewer_scope: scope,
    transport: "local_webrtc",
    cameras: {
      overview: cameraForRole("proof_primary"),
      qr: cameraForRole("proof_qr"),
    },
  });
}
