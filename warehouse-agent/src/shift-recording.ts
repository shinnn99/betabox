import type { CredentialItem } from "./commands";
import type { RecordingLifecycle } from "./recording-lifecycle";

const UUID_SHAPE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAFF_QR_RE = new RegExp(
  `^${UUID_SHAPE}\\.${UUID_SHAPE}\\.[A-Za-z0-9_-]{16,}$`,
  "i",
);

export function isStaffQrShape(rawValue: string): boolean {
  return STAFF_QR_RE.test(rawValue.trim());
}

export function camerasForShiftStart(
  cameras: CredentialItem[],
): CredentialItem[] {
  return cameras.filter(
    (camera) =>
      camera.station_id !== null &&
      (camera.role === "proof_primary" ||
        (camera.role === "proof_qr" && camera.scan_source === "camera")),
  );
}

/**
 * Chọn camera cần bật ghi khi quét được QR nhân viên — CHỈ của bàn đã quét.
 *
 * Kho dùng một agent cho mọi bàn (chốt với chủ dự án 17/09/2026). Trước
 * đây hàm này bật ghi MỌI camera đủ điều kiện của agent: đúng khi agent chỉ
 * phục vụ một bàn, nhưng khi phục vụ nhiều bàn thì quét QR ở BAN_01 sẽ bật
 * ghi cả BAN_03 — trộn bằng chứng của hai bàn vào nhau.
 *
 * `stationId`:
 *   - biết bàn (QR đọc được từ camera của bàn đó) → chỉ bàn đó;
 *   - không biết bàn (súng quét qua cổng serial — agent không biết súng đó
 *     gắn bàn nào) và agent chỉ có camera của ĐÚNG MỘT bàn → vẫn bật bàn đó,
 *     vì không có gì để nhầm; giữ nguyên hành vi kho một bàn;
 *   - không biết bàn mà agent có camera của NHIỀU bàn → không bật gì. Cloud
 *     sẽ quy mã về đúng bàn và mở ca; chậm vài giây còn hơn ghi nhầm bàn.
 */
export function pickShiftCameras(
  cameras: CredentialItem[],
  stationId: string | null,
): CredentialItem[] {
  const eligible = camerasForShiftStart(cameras);
  if (stationId) return eligible.filter((camera) => camera.station_id === stationId);
  const stations = new Set(eligible.map((camera) => camera.station_id));
  return stations.size === 1 ? eligible : [];
}

/**
 * Điều phối ghi hình tại máy bàn. Cache chỉ sống trong RAM nên URL RTSP có
 * credential không bị ghi xuống ổ. QR nhân viên hợp lệ về hình dạng sẽ bật
 * ghi trước khi request cloud chạy; cloud vẫn là nơi xác thực token và cấp
 * session_id chính thức qua lệnh start_recording.
 */
export class ShiftRecording {
  private cameras: CredentialItem[] = [];

  constructor(private readonly lifecycle: RecordingLifecycle) {}

  updateCameras(cameras: CredentialItem[]): void {
    this.cameras = [...cameras];
  }

  async onLocalStaffQr(
    rawValue: string,
    /** Bàn nơi mã được quét; null khi không biết (súng quét serial). */
    stationId: string | null,
  ): Promise<{
    matched: boolean;
    requested: number;
    started: number;
  }> {
    if (!isStaffQrShape(rawValue)) {
      return { matched: false, requested: 0, started: 0 };
    }
    const targets = pickShiftCameras(this.cameras, stationId);
    const results = await Promise.allSettled(
      targets.map((camera) => this.lifecycle.startLocalOne(camera)),
    );
    const started = results.filter(
      (result) => result.status === "fulfilled" && result.value,
    ).length;
    console.log(
      `[shift-recording] staff QR detected; station=${stationId ?? "khong ro"} requested=${targets.length} active=${started}`,
    );
    return { matched: true, requested: targets.length, started };
  }
}
