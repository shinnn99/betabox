/**
 * Mỗi camera thuộc bàn nào, đứng ở vị trí nào, bàn đó quét bằng gì và
 * đang có ca không — tính THEO TỪNG CAMERA.
 *
 * Vì sao phải theo từng camera: kho dùng MỘT agent cho mọi bàn (chốt với
 * chủ dự án 17/09/2026, "dùng 1 agent cho dễ quản lý"). Trước đây các giá
 * trị này lấy từ `warehouse_agents.station_id` — một bàn duy nhất — rồi áp
 * chung cho mọi camera của agent. Hệ quả: camera gắn vào bàn thứ hai có
 * livestream nhưng không bao giờ có vai trò, nên không được ghi theo ca
 * của bàn nó đang đứng, và clip bằng chứng của bàn đó rỗng.
 *
 * Hàm thuần — không đụng DB, để test được.
 */

export type CameraRole = "proof_primary" | "proof_qr";
export type ScanSource = "scanner" | "camera";

export interface CameraStationInfo {
  stationId: string | null;
  role: CameraRole | null;
  scanSource: ScanSource;
  stationHasOpenSession: boolean;
}

export function resolveCameraStations(input: {
  cameraIds: string[];
  /** Thiết bị kiểu camera (soft-link): `config_json.camera_id` + `role`. */
  devices: Array<{ id: string; config_json: Record<string, unknown> | null }>;
  /** Phân công ĐANG MỞ. */
  assignments: Array<{ device_id: string; station_id: string }>;
  stations: Array<{ id: string; scan_source: string | null }>;
  /** Bàn đang có ít nhất một ca mở. */
  openSessionStationIds: Set<string>;
}): Map<string, CameraStationInfo> {
  const wanted = new Set(input.cameraIds);
  const stationByDevice = new Map(input.assignments.map((a) => [a.device_id, a.station_id]));
  const scanSourceByStation = new Map(
    input.stations.map((s) => [s.id, s.scan_source === "camera" ? "camera" : "scanner"] as const),
  );

  const out = new Map<string, CameraStationInfo>();
  for (const cameraId of input.cameraIds) {
    out.set(cameraId, {
      stationId: null,
      role: null,
      scanSource: "scanner",
      stationHasOpenSession: false,
    });
  }

  for (const device of input.devices) {
    const cameraId = String(device.config_json?.camera_id ?? "");
    if (!cameraId || !wanted.has(cameraId)) continue;
    const stationId = stationByDevice.get(device.id);
    if (!stationId) continue;

    const rawRole = device.config_json?.role;
    // Vai trò không hợp lệ thì coi như CHƯA đặt vị trí. Không mặc định sang
    // toàn cảnh: đoán sai vai trò là clip lấy sai góc hình.
    const role: CameraRole | null =
      rawRole === "proof_primary" || rawRole === "proof_qr" ? rawRole : null;

    out.set(cameraId, {
      stationId,
      role,
      scanSource: scanSourceByStation.get(stationId) ?? "scanner",
      stationHasOpenSession: input.openSessionStationIds.has(stationId),
    });
  }
  return out;
}
