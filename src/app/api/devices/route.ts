import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { listCameras } from "@/lib/camera/service";

// BA cột heartbeat/probe, đừng dùng lẫn:
//   - warehouse_agents.last_seen_at (agent còn sống, 60s ngưỡng)
//   - camera_recording_sessions.last_heartbeat_at (session đang ghi, 90s)
//   - cameras.last_probe_at (camera nghe RTSP port, 90s)
const SESSION_HEARTBEAT_STALE_MS = Number(
  process.env.RECORDING_SESSION_STALE_MS ?? 90_000,
);
const AGENT_ONLINE_STALE_MS = Number(
  process.env.AGENT_ONLINE_STALE_MS ?? 60_000,
);
const CAMERA_PROBE_STALE_MS = Number(
  process.env.CAMERA_PROBE_STALE_MS ?? 90_000,
);

/**
 * "Trạng thái kết nối camera" — bốn nhánh. Kết hợp cameras.last_probe_at
 * + last_probe_ok + agent.last_seen_at để KHÔNG dồn mọi ca stale thành
 * "chưa rõ" — mình có `agent.last_seen_at` để phân biệt agent-chết vs
 * camera-chết, dùng nó.
 *   - probe tươi + ok=true → online
 *   - probe tươi + ok=false → offline (agent ping được, camera không nghe)
 *   - probe stale + agent sống → offline (agent chạy mà không tới cam)
 *   - probe stale + agent chết → warehouse_disconnected (không đổ lỗi cam)
 *   - chưa có probe (camera không trong desired-recording) → not_probed
 *     (UI hiển thị snapshot cameras.status như trước — không giả real-time)
 */
export type CameraOnlineState =
  | "online"
  | "offline"
  | "warehouse_disconnected"
  | "not_probed";

function deriveCameraOnlineState(input: {
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  agentLastSeenAt: string | null;
  now: number;
}): CameraOnlineState {
  const agentOffline = input.agentLastSeenAt
    ? input.now - Date.parse(input.agentLastSeenAt) > AGENT_ONLINE_STALE_MS
    : true;
  if (!input.lastProbeAt || input.lastProbeOk === null) {
    return "not_probed";
  }
  const probeAgeMs = input.now - Date.parse(input.lastProbeAt);
  const probeStale = probeAgeMs > CAMERA_PROBE_STALE_MS;
  if (!probeStale) {
    return input.lastProbeOk ? "online" : "offline";
  }
  // Stale: kết hợp agent.last_seen_at để phân biệt.
  return agentOffline ? "warehouse_disconnected" : "offline";
}

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
    // Ưu tiên session status='recording' (agent còn giữ) trước, không
    // theo started_at ngây thơ — vì có thể có session mồ côi
    // status='error' với started_at NEWER hơn session 'recording' đang
    // sống (sweep cũ chốt session A, user bấm start tạo B, agent vẫn
    // ghi A). Query 2 pass: pass 1 lấy session recording (partial
    // unique index đảm bảo tối đa 1 per camera); pass 2 lấy session
    // gần nhất cho camera chưa có row từ pass 1.
    const cameraIdList = cameras.map((c) => c.id);
    const { data: recSessions } = await admin
      .from("camera_recording_sessions")
      .select("camera_id, status, started_at, last_heartbeat_at")
      .eq("organization_id", ctx.organizationId)
      .in("camera_id", cameraIdList)
      .eq("status", "recording");

    const camerasWithoutRec = cameraIdList.filter(
      (id) => !(recSessions ?? []).some((r) => r.camera_id === id),
    );
    const { data: otherSessions } =
      camerasWithoutRec.length > 0
        ? await admin
            .from("camera_recording_sessions")
            .select("camera_id, status, started_at, last_heartbeat_at")
            .eq("organization_id", ctx.organizationId)
            .in("camera_id", camerasWithoutRec)
            .order("started_at", { ascending: false })
        : { data: [] as Array<{ camera_id: string; status: string; started_at: string; last_heartbeat_at: string | null }> };

    const sessions = [...(recSessions ?? []), ...(otherSessions ?? [])];

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

  // Agent online gần nhất trong org — dùng cho cả recording state VÀ
  // camera online state. Query 1 lần, dùng chung. (Trước đây query trong
  // if(cameras.length>0) block, giờ cần cả nhánh camera_online_state
  // dùng — kéo ra ngoài để không phụ thuộc có recording session hay không.)
  const { data: agentForOnline } = await admin
    .from("warehouse_agents")
    .select("last_seen_at")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nowForOnline = Date.now();

  // Attach the soft-link id, recording state, và camera online state.
  const cameraRows = cameras.map((c) => ({
    kind: "camera" as const,
    ...c,
    station_device_id: cameraSoftLinkByCameraId.get(c.id) ?? null,
    recording: recordingByCameraId.get(c.id) ?? null,
    camera_online_state: deriveCameraOnlineState({
      lastProbeAt: c.last_probe_at,
      lastProbeOk: c.last_probe_ok,
      agentLastSeenAt: agentForOnline?.last_seen_at ?? null,
      now: nowForOnline,
    }),
  }));

  return NextResponse.json({
    devices: [...cameraRows, ...scanners],
  });
}
