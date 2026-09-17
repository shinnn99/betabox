import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decryptPassword } from "@/lib/camera/crypto";
import { buildRtspUrl } from "@/lib/camera/rtsp";
import { selectCamerasWithMacFallback } from "./mac-columns";
import { resolveCameraStations, type CameraStationInfo } from "./camera-stations";

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
  /** E.1: agent can MAC de tu do lai IP khi probe hong. Null = chua biet. */
  mac_address: string | null;
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
  const CAMERA_COLUMNS =
    "id, camera_code, ip, rtsp_port, username, password_ciphertext, password_iv, password_tag, rtsp_path, rtsp_substream_path, mac_address";

  // Đây là đường đi của NGHIỆP VỤ CHÍNH: agent lấy credential để ghi hình.
  // Database chưa có cột MAC thì bỏ cột đó ra chứ không được hỏng cả truy
  // vấn — mất MAC chỉ mất khả năng tự dò IP, mất truy vấn là mất ghi hình.
  // Kiểu tường minh vì danh sách cột là biến (Supabase chỉ suy được kiểu
  // từ chuỗi hằng). `mac_address` để optional: nó vắng mặt trên database
  // chưa áp migration.
  interface CameraCredentialRow {
    id: string;
    camera_code: string;
    ip: string;
    rtsp_port: number;
    username: string;
    password_ciphertext: string | null;
    password_iv: string | null;
    password_tag: string | null;
    rtsp_path: string;
    rtsp_substream_path: string | null;
    mac_address?: string | null;
  }

  const { data: cams, error } = await selectCamerasWithMacFallback<
    CameraCredentialRow[] | null
  >(CAMERA_COLUMNS, (cols) => {
    let q = admin
      .from("cameras")
      .select(cols)
      .eq("organization_id", orgId)
      .eq("status", "active");
    if (agentId) q = q.eq("agent_id", agentId);
    if (cameraIds !== null) q = q.in("id", cameraIds);
    return q as unknown as PromiseLike<{
      data: CameraCredentialRow[] | null;
      error: { code?: string | null; message?: string | null } | null;
    }>;
  });
  if (error) return { error: error.message ?? "không đọc được danh sách camera" };

  // Bàn / vị trí / nguồn quét / ca mở — tính THEO TỪNG CAMERA, không lấy
  // chung một bàn của agent. Một agent phục vụ mọi bàn trong kho; xem
  // `camera-stations.ts` để biết vì sao.
  const cameraIdList = (cams ?? []).map((c) => c.id);
  let stationInfo = new Map<string, CameraStationInfo>();
  if (cameraIdList.length > 0) {
    const { data: deviceRows, error: devicesError } = await admin
      .from("station_devices")
      .select("id, config_json")
      .eq("organization_id", orgId)
      .eq("device_type", "camera")
      .neq("status", "archived");
    if (devicesError) return { error: devicesError.message };

    const wanted = new Set(cameraIdList);
    const cameraDevices = ((deviceRows ?? []) as Array<{
      id: string;
      config_json: Record<string, unknown> | null;
    }>).filter((d) => wanted.has(String(d.config_json?.camera_id ?? "")));

    let assignments: Array<{ device_id: string; station_id: string }> = [];
    if (cameraDevices.length > 0) {
      const { data: assignmentRows, error: assignmentsError } = await admin
        .from("station_device_assignments")
        .select("device_id, station_id")
        .eq("organization_id", orgId)
        .is("unassigned_at", null)
        .in("device_id", cameraDevices.map((d) => d.id));
      if (assignmentsError) return { error: assignmentsError.message };
      assignments = (assignmentRows ?? []) as Array<{ device_id: string; station_id: string }>;
    }

    const stationIds = [...new Set(assignments.map((a) => a.station_id))];
    let stations: Array<{ id: string; scan_source: string | null }> = [];
    const openSessionStationIds = new Set<string>();
    if (stationIds.length > 0) {
      const [stationsResult, sessionsResult] = await Promise.all([
        admin
          .from("packing_stations")
          .select("id, scan_source")
          .eq("organization_id", orgId)
          .in("id", stationIds),
        admin
          .from("staff_work_sessions")
          .select("station_id")
          .eq("organization_id", orgId)
          .eq("status", "active")
          .in("station_id", stationIds),
      ]);
      if (stationsResult.error) return { error: stationsResult.error.message };
      if (sessionsResult.error) return { error: sessionsResult.error.message };
      stations = (stationsResult.data ?? []) as Array<{ id: string; scan_source: string | null }>;
      for (const row of (sessionsResult.data ?? []) as Array<{ station_id: string | null }>) {
        if (row.station_id) openSessionStationIds.add(row.station_id);
      }
    }

    stationInfo = resolveCameraStations({
      cameraIds: cameraIdList,
      devices: cameraDevices,
      assignments,
      stations,
      openSessionStationIds,
    });
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
    const info = stationInfo.get(c.id);
    const role = info?.role ?? null;
    return {
      camera_id: c.id,
      camera_code: c.camera_code,
      rtsp_url: rtspUrl,
      rtsp_substream_url: rtspSubstreamUrl,
      transport: "tcp" as const,
      segment_seconds: 60,
      station_id: info?.stationId ?? null,
      role,
      scan_source: info?.scanSource ?? "scanner",
      scanner_device_code:
        role === "proof_qr" ? `qrcam_${c.camera_code}`.toLowerCase() : null,
      station_has_open_session: info?.stationHasOpenSession ?? false,
      // MAC KHÔNG phải bí mật (nó nằm sẵn trên mọi gói tin trong LAN) nên
      // gửi kèm credential là an toàn, và đây là kênh duy nhất agent đã
      // biết chắc "camera này thuộc về mình".
      mac_address: c.mac_address ?? null,
    };
  });

  return { items };
}
