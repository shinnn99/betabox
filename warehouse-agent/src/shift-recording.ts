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

  async onLocalStaffQr(rawValue: string): Promise<{
    matched: boolean;
    requested: number;
    started: number;
  }> {
    if (!isStaffQrShape(rawValue)) {
      return { matched: false, requested: 0, started: 0 };
    }
    const targets = camerasForShiftStart(this.cameras);
    const results = await Promise.allSettled(
      targets.map((camera) => this.lifecycle.startLocalOne(camera)),
    );
    const started = results.filter(
      (result) => result.status === "fulfilled" && result.value,
    ).length;
    console.log(
      `[shift-recording] staff QR detected; requested=${targets.length} active=${started}`,
    );
    return { matched: true, requested: targets.length, started };
  }
}
