import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { enqueueStartRecordingV2 } from "@/lib/agent-commands/enqueue";
import { invalidateCameraCaches } from "./service";

export type StationCameraRole = "proof_primary" | "proof_qr";

interface SetupPayload {
  camera_id?: unknown;
  station_id?: unknown;
  role?: unknown;
  requested_by?: unknown;
  created_new?: unknown;
}

export async function findCameraStation(
  organizationId: string,
  cameraId: string,
): Promise<{ station_id: string; station_code: string; station_name: string } | null> {
  const admin = createAdminClient();
  const { data: devices, error } = await admin
    .from("station_devices")
    .select("id, config_json")
    .eq("organization_id", organizationId)
    .eq("device_type", "camera")
    .neq("status", "archived");
  if (error) throw error;
  const device = (devices ?? []).find((row) => String(row.config_json?.camera_id ?? "") === cameraId);
  if (!device) return null;
  const { data: assignment, error: assignmentError } = await admin
    .from("station_device_assignments")
    .select("station_id, packing_stations(code, name)")
    .eq("organization_id", organizationId)
    .eq("device_id", device.id)
    .is("unassigned_at", null)
    .maybeSingle();
  if (assignmentError) throw assignmentError;
  if (!assignment) return null;
  const station = Array.isArray(assignment.packing_stations)
    ? assignment.packing_stations[0]
    : assignment.packing_stations;
  return {
    station_id: assignment.station_id,
    station_code: station?.code ?? "",
    station_name: station?.name ?? "",
  };
}

async function ensureQrVirtualScanner(
  organizationId: string,
  stationId: string,
  camera: { id: string; camera_code: string; name: string },
  now: string,
): Promise<void> {
  const admin = createAdminClient();
  const deviceCode = `qrcam_${camera.camera_code}`.toLowerCase();
  const { data: existing } = await admin
    .from("station_devices")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("device_code", deviceCode)
    .maybeSingle();
  let deviceId = existing?.id as string | undefined;
  if (!deviceId) {
    const { data, error } = await admin
      .from("station_devices")
      .insert({
        organization_id: organizationId,
        device_code: deviceCode,
        device_type: "scanner",
        name: `QR camera ${camera.name}`,
        status: "active",
        connection_type: "unknown",
        config_json: { virtual_source: "camera_qr", camera_id: camera.id },
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`create virtual QR scanner failed: ${error?.message}`);
    deviceId = data.id;
  }
  const { error: closeError } = await admin
    .from("station_device_assignments")
    .update({ unassigned_at: now, status: "ended" })
    .eq("organization_id", organizationId)
    .eq("device_id", deviceId)
    .is("unassigned_at", null);
  if (closeError) throw closeError;
  const { error: assignError } = await admin.from("station_device_assignments").insert({
    organization_id: organizationId,
    device_id: deviceId,
    station_id: stationId,
    assigned_at: now,
    status: "active",
  });
  if (assignError) throw assignError;
}

export async function finalizeConnectCamera(params: {
  organizationId: string;
  agentId: string;
  payload: SetupPayload;
  result: Record<string, unknown>;
}): Promise<void> {
  const cameraId = typeof params.payload.camera_id === "string" ? params.payload.camera_id : "";
  const stationId = typeof params.payload.station_id === "string" ? params.payload.station_id : "";
  const requestedBy = typeof params.payload.requested_by === "string" ? params.payload.requested_by : "";
  const role = params.payload.role === "proof_qr" ? "proof_qr" : params.payload.role === "proof_primary" ? "proof_primary" : null;
  if (!cameraId || !stationId || !requestedBy || !role) throw new Error("invalid connect_camera setup payload");
  const rtspPath = typeof params.result.rtspPath === "string" ? params.result.rtspPath : "";
  if (!rtspPath) throw new Error("connect_camera result missing rtspPath");

  const admin = createAdminClient();
  const { data: camera, error: cameraError } = await admin
    .from("cameras")
    .update({
      agent_id: params.agentId,
      status: "active",
      rtsp_path: rtspPath,
      rtsp_substream_path: typeof params.result.rtspSubstreamPath === "string" ? params.result.rtspSubstreamPath : null,
      last_tested_at: new Date().toISOString(),
      last_test_result: {
        success: true,
        manufacturer: params.result.manufacturer ?? null,
        model: params.result.model ?? null,
        tested_via: "agent_connect_camera",
      },
    })
    .eq("organization_id", params.organizationId)
    .eq("agent_id", params.agentId)
    .eq("id", cameraId)
    .select("id, camera_code, name")
    .single();
  if (cameraError || !camera) throw new Error(`activate camera failed: ${cameraError?.message}`);

  const previous = await findCameraStation(params.organizationId, cameraId);
  const { data: cameraDevices, error: deviceLookupError } = await admin
    .from("station_devices")
    .select("id, config_json")
    .eq("organization_id", params.organizationId)
    .eq("device_type", "camera")
    .neq("status", "archived");
  if (deviceLookupError) throw deviceLookupError;
  let cameraDevice = (cameraDevices ?? []).find((row) => String(row.config_json?.camera_id ?? "") === cameraId);
  if (!cameraDevice) {
    const { data, error } = await admin
      .from("station_devices")
      .insert({
        organization_id: params.organizationId,
        device_code: `auto_${camera.camera_code}`,
        device_type: "camera",
        name: camera.name,
        status: "active",
        config_json: { camera_id: cameraId, camera_code: camera.camera_code, role },
      })
      .select("id, config_json")
      .single();
    if (error || !data) throw new Error(`create camera device failed: ${error?.message}`);
    cameraDevice = data;
  } else {
    const { error } = await admin
      .from("station_devices")
      .update({ config_json: { ...cameraDevice.config_json, camera_id: cameraId, camera_code: camera.camera_code, role } })
      .eq("organization_id", params.organizationId)
      .eq("id", cameraDevice.id);
    if (error) throw error;
  }

  const now = new Date().toISOString();
  const { error: closeOwnError } = await admin
    .from("station_device_assignments")
    .update({ unassigned_at: now, status: "ended" })
    .eq("organization_id", params.organizationId)
    .eq("device_id", cameraDevice.id)
    .is("unassigned_at", null);
  if (closeOwnError) throw closeOwnError;

  const { data: targetAssignments, error: targetError } = await admin
    .from("station_device_assignments")
    .select("id, station_devices!inner(device_type, config_json)")
    .eq("organization_id", params.organizationId)
    .eq("station_id", stationId)
    .is("unassigned_at", null);
  if (targetError) throw targetError;
  const sameRoleIds = (targetAssignments ?? []).flatMap((row) => {
    const device = Array.isArray(row.station_devices) ? row.station_devices[0] : row.station_devices;
    return device?.device_type === "camera" && device.config_json?.role === role ? [row.id] : [];
  });
  if (sameRoleIds.length > 0) {
    const { error } = await admin
      .from("station_device_assignments")
      .update({ unassigned_at: now, status: "ended" })
      .eq("organization_id", params.organizationId)
      .in("id", sameRoleIds);
    if (error) throw error;
  }
  const { error: assignmentError } = await admin.from("station_device_assignments").insert({
    organization_id: params.organizationId,
    device_id: cameraDevice.id,
    station_id: stationId,
    assigned_at: now,
    status: "active",
  });
  if (assignmentError) throw assignmentError;
  if (role === "proof_qr") {
    await ensureQrVirtualScanner(params.organizationId, stationId, camera, now);
  }
  invalidateCameraCaches(params.organizationId);

  if (previous && previous.station_id !== stationId) {
    await audit({
      organizationId: params.organizationId,
      actorUserId: requestedBy,
      action: "camera.station.move",
      targetType: "camera",
      targetId: cameraId,
      metadata: { from_station_id: previous.station_id, to_station_id: stationId, role },
    });
  }

  const { count: openSessions } = await admin
    .from("staff_work_sessions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", params.organizationId)
    .eq("station_id", stationId)
    .eq("status", "active");
  if ((openSessions ?? 0) > 0) {
    await enqueueStartRecordingV2({
      organizationId: params.organizationId,
      cameraId,
      agentId: params.agentId,
      createdBy: requestedBy,
      transport: "tcp",
      segmentSeconds: Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60),
      outputDir: `_agent_managed/${camera.camera_code}`,
    });
  }
}
