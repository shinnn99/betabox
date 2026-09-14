import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptPassword } from "@/lib/camera/crypto";
import { buildRtspUrl } from "@/lib/camera/rtsp";

type Admin = ReturnType<typeof createAdminClient>;

export interface CameraCredentialItem {
  camera_id: string;
  camera_code: string;
  rtsp_url: string;
  rtsp_substream_url: string | null;
  transport: "tcp";
  segment_seconds: number;
  station_id: string | null;
  role: "proof_primary" | "proof_qr" | null;
  scan_source: "scanner" | "camera";
  scanner_device_code: string | null;
  station_has_open_session: boolean;
}

/**
 * Credential (RTSP URL đã giải mã) của camera trong MỘT org.
 *
 * `cameraIds = null` → mọi camera `status='active'` của org.
 *
 * `status='active'` áp cho CẢ HAI nhánh (2026-08-05). Trước đây nhánh
 * camera_ids trả credential bất kể status → bấm "Tạm ngưng" trên dashboard
 * không hề tới được agent: agent vẫn xin được credential, boot() vẫn thấy
 * camera trong response nên giữ desired, và long-retry vẫn spawn ffmpeg mỗi
 * 5 phút. Ca cắn thật: hik_01 kho Đại Kim bị tạm ngưng 31/07 nhưng vẫn bị
 * thử ghi tới 05/08 (~78 lần/ngày), và người dùng KHÔNG có đường nào dừng
 * qua UI vì cloud tin là camera không ghi.
 *
 * Response thiếu camera = thu hồi ý định ghi, agent phải xóa desired. Đây là
 * hợp đồng giữa hai bên — xem `syncDesiredWithActiveCameras` và nhánh
 * `!cred` trong long-retry ở recording-lifecycle.ts.
 *
 * Caller PHẢI truyền orgId lấy từ HMAC identity của agent, KHÔNG lấy từ body.
 */
export async function listCameraCredentials(
  admin: Admin,
  orgId: string,
  cameraIds: string[] | null,
  agentId?: string,
): Promise<{ items: CameraCredentialItem[] } | { error: string }> {
  let camsQuery = admin
    .from("cameras")
    .select(
      "id, camera_code, ip, rtsp_port, username, password_ciphertext, password_iv, password_tag, rtsp_path, rtsp_substream_path",
    )
    .eq("organization_id", orgId)
    .eq("status", "active");
  if (agentId) camsQuery = camsQuery.eq("agent_id", agentId);
  if (cameraIds !== null) camsQuery = camsQuery.in("id", cameraIds);

  const { data: cams, error } = await camsQuery;
  if (error) return { error: error.message };

  let stationId: string | null = null;
  let scanSource: "scanner" | "camera" = "scanner";
  let stationHasOpenSession = false;
  const roleByCameraId = new Map<string, "proof_primary" | "proof_qr">();

  if (agentId) {
    const { data: agent, error: agentError } = await admin
      .from("warehouse_agents")
      .select("station_id")
      .eq("organization_id", orgId)
      .eq("id", agentId)
      .maybeSingle();
    if (agentError) return { error: agentError.message };
    stationId = typeof agent?.station_id === "string" ? agent.station_id : null;

    if (stationId) {
      const [{ data: station, error: stationError }, { count, error: sessionsError }, devicesResult] =
        await Promise.all([
          admin
            .from("packing_stations")
            .select("scan_source")
            .eq("organization_id", orgId)
            .eq("id", stationId)
            .maybeSingle(),
          admin
            .from("staff_work_sessions")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .eq("station_id", stationId)
            .eq("status", "active"),
          admin
            .from("station_devices")
            .select("id, config_json")
            .eq("organization_id", orgId)
            .eq("device_type", "camera")
            .neq("status", "archived"),
        ]);
      if (stationError) return { error: stationError.message };
      if (sessionsError) return { error: sessionsError.message };
      if (devicesResult.error) return { error: devicesResult.error.message };
      scanSource = station?.scan_source === "camera" ? "camera" : "scanner";
      stationHasOpenSession = (count ?? 0) > 0;

      const deviceRows = (devicesResult.data ?? []).flatMap((device) => {
        const cameraId = String(device.config_json?.camera_id ?? "");
        const role = device.config_json?.role;
        return cameraId && (role === "proof_primary" || role === "proof_qr")
          ? [{ deviceId: device.id, cameraId, role }]
          : [];
      });
      if (deviceRows.length > 0) {
        const { data: assignments, error: assignmentsError } = await admin
          .from("station_device_assignments")
          .select("device_id")
          .eq("organization_id", orgId)
          .eq("station_id", stationId)
          .is("unassigned_at", null)
          .in("device_id", deviceRows.map((device) => device.deviceId));
        if (assignmentsError) return { error: assignmentsError.message };
        const assignedDeviceIds = new Set((assignments ?? []).map((row) => row.device_id));
        for (const device of deviceRows) {
          if (assignedDeviceIds.has(device.deviceId)) {
            roleByCameraId.set(device.cameraId, device.role);
          }
        }
      }
    }
  }

  const items = (cams ?? []).map((c) => {
    let password: string | null = null;
    if (c.password_ciphertext && c.password_iv && c.password_tag) {
      try {
        password = decryptPassword({
          ciphertext: c.password_ciphertext,
          iv: c.password_iv,
          tag: c.password_tag,
        });
      } catch {
        password = null;
      }
    }
    const rtspUrl = buildRtspUrl({
      ip: c.ip,
      port: c.rtsp_port,
      username: c.username,
      password,
      path: c.rtsp_path,
    });
    const rtspSubstreamUrl = c.rtsp_substream_path
      ? buildRtspUrl({
          ip: c.ip,
          port: c.rtsp_port,
          username: c.username,
          password,
          path: c.rtsp_substream_path,
        })
      : null;
    const role = roleByCameraId.get(c.id) ?? null;
    return {
      camera_id: c.id,
      camera_code: c.camera_code,
      rtsp_url: rtspUrl,
      rtsp_substream_url: rtspSubstreamUrl,
      transport: "tcp" as const,
      segment_seconds: 60,
      station_id: stationId,
      role,
      scan_source: scanSource,
      scanner_device_code:
        role === "proof_qr" ? `qrcam_${c.camera_code}`.toLowerCase() : null,
      station_has_open_session: stationHasOpenSession,
    };
  });

  return { items };
}
