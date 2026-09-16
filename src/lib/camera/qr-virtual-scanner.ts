/**
 * Giữ bất biến: **camera vai trò `proof_qr` đã gán vào bàn thì phải có một
 * "scanner ảo" `qrcam_<mã camera>` đang hoạt động và gán vào ĐÚNG bàn đó.**
 *
 * Vì sao cần: agent báo mã quét được từ camera dưới tên thiết bị
 * `qrcam_<mã camera>`. Cloud tra tên đó qua `resolve_scanner_at`, hàm này
 * đòi thiết bị `status='active'` VÀ có một phân công đang mở. Thiếu một
 * trong hai thì mọi lần quét trả `unmapped_scanner`: scan thô vẫn được lưu
 * nhưng không quy về bàn nào, nên không tạo được sự kiện đóng đơn và không
 * có video bằng chứng.
 *
 * Chuyện đã xảy ra thật (16/09/2026): camera `dahua_3` được chuyển sang bàn
 * BAN_03 của một tổ chức khác bằng cách tạo bản ghi thiết bị mới, không đi
 * qua `POST /api/station-device-assignments` — nhánh duy nhất biết tạo
 * scanner ảo. Scanner ảo cũ bị archive lại ở tổ chức cũ, tổ chức mới không
 * có cái nào. Mọi lần quét hỏng trong im lặng suốt hơn một ngày: dashboard
 * không có cảnh báo nào, chỉ một dòng log ở agent.
 *
 * Nên việc sửa chữa nằm ở đây, chạy cùng nhịp tự liên kết thiết bị của
 * `ensureCameraSoftLinks`, thay vì chờ ai đó bấm đúng nút.
 */

export interface QrCameraDeviceInput {
  /** `station_devices.id` của thiết bị kiểu camera, vai trò proof_qr. */
  deviceId: string;
  /** `config_json.camera_id`. */
  cameraId: string;
  /** Bàn mà camera đang gán; null = chưa gán vào đâu. */
  stationId: string | null;
  /** Tên hiển thị của thiết bị camera, dùng đặt tên scanner ảo. */
  name: string;
}

export interface VirtualScannerInput {
  deviceId: string;
  deviceCode: string;
  status: string;
  /** Bàn của phân công đang mở; null = không có phân công nào đang mở. */
  stationId: string | null;
}

export type VirtualScannerRepair =
  | {
      kind: "create";
      deviceCode: string;
      cameraId: string;
      stationId: string;
      name: string;
    }
  | { kind: "activate"; deviceId: string; deviceCode: string }
  | {
      kind: "assign";
      deviceId: string;
      deviceCode: string;
      stationId: string;
    };

/** Tên thiết bị ảo cho một camera. Phải khớp với `POST /api/station-device-assignments`. */
export function virtualScannerCode(cameraCode: string): string {
  return `qrcam_${cameraCode}`.toLowerCase();
}

/**
 * Tính danh sách việc cần sửa. Hàm thuần — không đụng DB, để test được.
 *
 * Ba ràng buộc cố ý:
 *   - Camera chưa gán vào bàn nào thì KHÔNG tạo gì. Không có bàn để soi
 *     chiếu thì tạo scanner ảo chỉ là rác.
 *   - Không bao giờ gỡ scanner ảo. Sai lệch được sửa bằng cách gán lại
 *     đúng bàn; gỡ là mất dấu vết vận hành.
 *   - Camera không có `camera_code` (không tra được) thì bỏ qua, vì tên
 *     thiết bị ảo phải suy ra được từ mã camera.
 */
export function planVirtualScannerRepairs(input: {
  qrCameraDevices: QrCameraDeviceInput[];
  virtualScanners: VirtualScannerInput[];
  cameraCodeById: Map<string, string>;
}): VirtualScannerRepair[] {
  const byCode = new Map(
    input.virtualScanners.map((scanner) => [
      scanner.deviceCode.toLowerCase(),
      scanner,
    ]),
  );
  const repairs: VirtualScannerRepair[] = [];

  for (const device of input.qrCameraDevices) {
    if (!device.stationId) continue;
    const cameraCode = input.cameraCodeById.get(device.cameraId);
    if (!cameraCode) continue;

    const code = virtualScannerCode(cameraCode);
    const existing = byCode.get(code);

    if (!existing) {
      repairs.push({
        kind: "create",
        deviceCode: code,
        cameraId: device.cameraId,
        stationId: device.stationId,
        name: `QR camera ${device.name || cameraCode}`,
      });
      continue;
    }

    if (existing.status !== "active") {
      repairs.push({
        kind: "activate",
        deviceId: existing.deviceId,
        deviceCode: code,
      });
    }
    if (existing.stationId !== device.stationId) {
      repairs.push({
        kind: "assign",
        deviceId: existing.deviceId,
        deviceCode: code,
        stationId: device.stationId,
      });
    }
  }

  return repairs;
}
