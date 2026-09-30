import { NextResponse } from "next/server";
import { requireStationLiveAccess } from "@/lib/live/station-access";
import {
  buildWhepUrl,
  relayPathName,
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
  const { stationId } = await context.params;
  // Cùng một chốt với luồng sự kiện live: quyền vào + phạm vi bàn.
  const access = await requireStationLiveAccess(stationId);
  if (access instanceof NextResponse) return access;
  const { admin, ctx, scope, station } = access;

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
