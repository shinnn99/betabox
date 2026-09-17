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
 *
 * Phạm vi: CHỈ những bàn có `scan_source = 'camera'`. Bàn dùng súng quét
 * phần cứng vẫn có thể có camera ở vị trí QR (để lấy góc đọc mã cho clip),
 * nhưng không được sinh scanner ảo — thiết bị đó không tồn tại ngoài kho.
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
    }
  /** Gỡ khỏi bàn và cho nghỉ: không còn camera QR nào đứng sau nó. */
  | { kind: "detach"; deviceId: string; deviceCode: string };

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
 *   - Chỉ gỡ scanner ảo khi KHÔNG còn camera QR nào đứng sau nó. Gỡ ở
 *     đây là bỏ gán + cho nghỉ, không xoá: bản ghi vẫn còn để truy vết, và
 *     lần sau cần thì chính hàm này bật lại.
 *   - Camera không có `camera_code` (không tra được) thì bỏ qua, vì tên
 *     thiết bị ảo phải suy ra được từ mã camera.
 */
export function planVirtualScannerRepairs(input: {
  qrCameraDevices: QrCameraDeviceInput[];
  virtualScanners: VirtualScannerInput[];
  cameraCodeById: Map<string, string>;
  /**
   * Bàn quét mã bằng CAMERA. Bàn dùng súng quét phần cứng không nằm trong
   * đây và sẽ không sinh scanner ảo nào.
   */
  cameraScanStationIds: Set<string>;
}): VirtualScannerRepair[] {
  const byCode = new Map(
    input.virtualScanners.map((scanner) => [
      scanner.deviceCode.toLowerCase(),
      scanner,
    ]),
  );
  const repairs: VirtualScannerRepair[] = [];

  // Tên thiết bị ảo ĐƯỢC PHÉP tồn tại: ứng với một camera QR đang gán vào
  // một bàn quét bằng camera.
  const wanted = new Set<string>();
  for (const device of input.qrCameraDevices) {
    if (!device.stationId) continue;
    if (!input.cameraScanStationIds.has(device.stationId)) continue;
    const code = input.cameraCodeById.get(device.cameraId);
    if (code) wanted.add(virtualScannerCode(code));
  }

  // Scanner ảo còn sót: camera của nó đã chuyển sang vị trí toàn cảnh, đã
  // rời bàn, hoặc bàn đã chuyển sang dùng súng quét. Để nguyên thì danh
  // sách thiết bị có một thứ không tồn tại ngoài kho — và người vận hành
  // tưởng bàn đang có hai nguồn quét.
  for (const scanner of input.virtualScanners) {
    const code = scanner.deviceCode.toLowerCase();
    if (wanted.has(code)) continue;
    if (scanner.status !== "active" && scanner.stationId === null) continue;
    repairs.push({ kind: "detach", deviceId: scanner.deviceId, deviceCode: code });
  }

  for (const device of input.qrCameraDevices) {
    if (!device.stationId) continue;
    // Bàn dùng súng quét riêng thì camera ở vị trí QR chỉ đóng vai trò góc
    // quay cho clip bằng chứng, KHÔNG phải nguồn tạo scan — sinh scanner ảo
    // ở đây là đẻ ra một thiết bị không có thật trong kho.
    if (!input.cameraScanStationIds.has(device.stationId)) continue;
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
