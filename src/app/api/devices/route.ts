import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { listCameras } from "@/lib/camera/service";

// Đồng bộ với ngưỡng ở /api/cameras/[id]/recording/status.
// session.last_heartbeat_at (90s) khác agent.last_seen_at (60s) —
// hai cột hai việc, đừng dùng lẫn.
const SESSION_HEARTBEAT_STALE_MS = Number(
  process.env.RECORDING_SESSION_STALE_MS ?? 90_000,
);
const AGENT_ONLINE_STALE_MS = Number(
  process.env.AGENT_ONLINE_STALE_MS ?? 60_000,
);

export const runtime = "nodejs";

// Unified listing for /dashboard/devices. Cameras and scanners live in
// different tables (cameras + station_devices), but the operator UI
// shouldn't have to think about that. We coalesce both into one shape
// with a `kind` discriminator; the UI filters by kind for the tabs.
//
// Camera rows go through listCameras() which lazy-creates the matching
// station_devices soft-link, so the assignment endpoints work uniformly
// for both kinds without the UI having to special-case camera creation.

interface StationAssignmentRow {
  device_id: string;
  station_id: string;
  assigned_at: string;
  packing_stations:
    | { code: string; name: string; warehouse_id: string }
    | { code: string; name: string; warehouse_id: string }[]
    | null;
}

export async function GET() {
  const ctx = await requirePermission("camera.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();

  // --- Camera rows ---------------------------------------------------------
  // listCameras() handles lazy soft-link creation. Even if the user has
  // never visited /dashboard/devices before, every camera will end up
  // with a station_devices row after this call, ready for the assign
  // endpoint to attach a station.
  const cameras = await listCameras(ctx.organizationId);

  // --- Station device rows (scanners + the camera soft-links) --------------
  const { data: stationDevices, error: sdErr } = await admin
    .from("station_devices")
    .select(
      "id, device_code, device_type, name, config_json, status, created_at, updated_at, connection_type, device_identity, current_port, connection_status, last_seen_at, last_error, bound_agent_id",
    )
    .eq("organization_id", ctx.organizationId)
    .neq("status", "archived")
    .order("device_code");
  if (sdErr) {
    return NextResponse.json({ error: sdErr.message }, { status: 500 });
  }

  const { data: assigns } = await admin
    .from("station_device_assignments")
    .select(
      "device_id, station_id, assigned_at, packing_stations ( code, name, warehouse_id )",
    )
    .eq("organization_id", ctx.organizationId)
    .is("unassigned_at", null);

  const assignByDevice = new Map<string, StationAssignmentRow>();
  for (const a of (assigns ?? []) as StationAssignmentRow[]) {
    assignByDevice.set(a.device_id, a);
  }

  // Map scanner rows. We also stash the soft-link station_device id of
  // each camera so the UI can call POST /station-device-assignments
  // without having to discover the soft-link itself.
  const cameraSoftLinkByCameraId = new Map<string, string>();
  const scanners: Array<Record<string, unknown>> = [];
  for (const sd of (stationDevices ?? []) as Array<
    Record<string, unknown> & {
      id: string;
      device_type: string;
      config_json: Record<string, unknown> | null;
    }
  >) {
    if (sd.device_type === "camera") {
      const cid = String(sd.config_json?.camera_id ?? "");
      if (cid) cameraSoftLinkByCameraId.set(cid, sd.id);
      continue; // camera detail is surfaced via the camera row, not here
    }
    if (sd.device_type !== "scanner") continue; // printer/scale not surfaced yet
    const a = assignByDevice.get(sd.id);
    const ps = a
      ? Array.isArray(a.packing_stations)
        ? a.packing_stations[0]
        : a.packing_stations
      : null;
    scanners.push({
      kind: "scanner",
      ...sd,
      current_station:
        a && ps
          ? {
              station_id: a.station_id,
              station_code: ps.code,
              station_name: ps.name,
              warehouse_id: ps.warehouse_id,
              assigned_at: a.assigned_at,
            }
          : null,
    });
  }

  // Batch recording status per camera. Đọc DB-only theo agent-pattern:
  // session.status + session.last_heartbeat_at + agent.last_seen_at. Ba
  // nhánh khớp /api/cameras/[id]/recording/status ui_state:
  //   - status=recording + heartbeat tươi + agent online → recording
  //   - status=recording + heartbeat stale hoặc agent offline
  //       → agent_disconnected (KHÔNG error — agent hiccup vẫn ghi)
  //   - status=stopped → stopped
  //   - status=error → error
  // Trước đây cross-check `isAlive(cameraId)` với process map local trên
  // Vercel — luôn empty → luôn nói "không ghi" dù agent kho đang ghi thật.
  let recordingByCameraId = new Map<
    string,
    {
      is_recording: boolean;
      ui_state: "recording" | "agent_disconnected" | "stopped" | "error";
    }
  >();
  if (cameras.length > 0) {
    const { data: sessions } = await admin
      .from("camera_recording_sessions")
      .select("camera_id, status, started_at, last_heartbeat_at")
      .eq("organization_id", ctx.organizationId)
      .in(
        "camera_id",
        cameras.map((c) => c.id),
      )
      .order("started_at", { ascending: false });

    // Agent online gần nhất trong org — cùng cách xác định với route
    // /status. Một truy vấn đủ vì UI cần 1 kết luận per org (đang
    // multi-agent thì mở rộng sau — session vẫn thuộc đúng org).
    const { data: agent } = await admin
      .from("warehouse_agents")
      .select("last_seen_at")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const now = Date.now();
    const agentOffline = agent?.last_seen_at
      ? now - Date.parse(agent.last_seen_at) > AGENT_ONLINE_STALE_MS
      : true;

    const seen = new Set<string>();
    for (const s of (sessions ?? []) as Array<{
      camera_id: string;
      status: "recording" | "stopped" | "error";
      last_heartbeat_at: string | null;
    }>) {
      if (seen.has(s.camera_id)) continue;
      seen.add(s.camera_id);
      let uiState: "recording" | "agent_disconnected" | "stopped" | "error";
      if (s.status === "stopped") uiState = "stopped";
      else if (s.status === "error") uiState = "error";
      else {
        const hbAgeMs = s.last_heartbeat_at
          ? now - Date.parse(s.last_heartbeat_at)
          : Infinity;
        const hbStale = hbAgeMs > SESSION_HEARTBEAT_STALE_MS;
        uiState = hbStale || agentOffline ? "agent_disconnected" : "recording";
      }
      recordingByCameraId.set(s.camera_id, {
        is_recording: uiState === "recording",
        ui_state: uiState,
      });
    }
  }

  // Attach the soft-link id and live recording state to each camera row.
  const cameraRows = cameras.map((c) => ({
    kind: "camera" as const,
    ...c,
    station_device_id: cameraSoftLinkByCameraId.get(c.id) ?? null,
    recording: recordingByCameraId.get(c.id) ?? null,
  }));

  return NextResponse.json({
    devices: [...cameraRows, ...scanners],
  });
}
