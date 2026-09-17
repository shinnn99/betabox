import type { CredentialItem } from "../commands";
import { swallow } from "../fatal";
import { relayPathName } from "../live/relay-hub";
import { decodeGrayFrame } from "./qr-decoder";
import {
  QrFrameSource,
  QR_FRAME_HEIGHT,
  QR_FRAME_WIDTH,
} from "./qr-frame-source";
import { QrZone, type DecodedQr, type QrEmission } from "./qr-zone";

export interface CameraQrScan {
  camera: CredentialItem;
  emission: QrEmission;
}

interface TestCollector {
  values: Map<string, DecodedQr>;
}

/** Nguồn khung hình tối thiểu mà dịch vụ cần — tách ra để test được. */
export interface QrSource {
  start(): void;
  stop(): Promise<void>;
}

type SourceFactory = (
  pathName: string,
  onFrame: (frame: Uint8Array, capturedAt: Date) => void,
) => QrSource;

/** Một camera QR đang được đọc. Mỗi bàn một cái, độc lập nhau hoàn toàn. */
interface QrTarget {
  camera: CredentialItem;
  pathName: string;
  source: QrSource | null;
  zone: QrZone;
  decoderBusy: boolean;
  lastMultipleWarningAt: number;
}

/**
 * Đọc mã QR từ camera — MỖI BÀN MỘT LUỒNG, chạy song song.
 *
 * Vì sao nhiều luồng: kho dùng một agent cho mọi bàn (chốt với chủ dự án
 * 17/09/2026). Trước đây dịch vụ này chỉ giữ MỘT camera — `find` lấy phần tử
 * đầu tiên — nên agent phục vụ hai bàn quét bằng camera thì chỉ một bàn đọc
 * được mã, bàn kia quét gì cũng im lặng.
 *
 * Mỗi camera có vùng khử trùng (`QrZone`) riêng: dùng chung một vùng thì
 * cùng một mã giơ lên ở hai bàn cách nhau vài giây sẽ bị coi là quét trùng
 * và nuốt mất lần thứ hai.
 *
 * Chi phí: mỗi luồng là một ffmpeg đọc 10 hình/giây ở 640x360 xám cộng một
 * lần giải mã mỗi hình. Chỉ bàn `scan_source = 'camera'` mới có luồng; bàn
 * dùng súng quét không tốn gì.
 */
export class QrScanService {
  private cameras: CredentialItem[] = [];
  private readonly targets = new Map<string, QrTarget>();
  private readonly testCollectors = new Set<TestCollector>();
  /** Camera đang được thử giải mã tạm thời dù bàn không quét bằng camera. */
  private testCameraId: string | null = null;
  private readonly createSource: SourceFactory;
  private readonly decode: typeof decodeGrayFrame;

  constructor(
    private readonly options: {
      ffmpegBin: string;
      frameRate: number;
      confirmFrames: number;
      absenceMs: number;
      onScan: (scan: CameraQrScan) => Promise<void> | void;
      onWarning?: (warning: "multiple_qr") => void;
      /** Cho test: thay nguồn khung hình ffmpeg. */
      createSource?: SourceFactory;
      /** Cho test: thay bộ giải mã. */
      decode?: typeof decodeGrayFrame;
    },
  ) {
    this.createSource =
      options.createSource ??
      ((pathName, onFrame) =>
        new QrFrameSource(options.ffmpegBin, pathName, options.frameRate, onFrame));
    this.decode = options.decode ?? decodeGrayFrame;
  }

  /** Camera QR đang thực sự tạo scan: gắn bàn và bàn quét bằng camera. */
  static scanningCameras(cameras: CredentialItem[]): CredentialItem[] {
    return cameras.filter(
      (camera) =>
        camera.role === "proof_qr" &&
        camera.station_id !== null &&
        camera.scan_source === "camera",
    );
  }

  /** Đang đọc camera nào — dùng cho log và test. */
  activeCameraIds(): string[] {
    return [...this.targets.keys()];
  }

  async reconcile(cameras: CredentialItem[]): Promise<void> {
    this.cameras = [...cameras];
    const desired = new Map(
      QrScanService.scanningCameras(this.cameras).map((camera) => [camera.camera_id, camera]),
    );

    // Dừng luồng không còn cần: camera rời bàn, đổi vị trí, hoặc bàn chuyển
    // sang súng quét. Đường relay đổi (thêm/bớt luồng phụ) cũng dựng lại.
    for (const [cameraId, target] of [...this.targets]) {
      const next = desired.get(cameraId);
      const keepForTest = cameraId === this.testCameraId && this.testCollectors.size > 0;
      if ((next && this.relayPath(next) === target.pathName) || keepForTest) continue;
      await this.stopTarget(cameraId);
    }

    for (const [cameraId, camera] of desired) {
      const existing = this.targets.get(cameraId);
      if (existing) {
        // Giữ nguyên luồng, chỉ cập nhật bản ghi (bàn có thể vừa đổi).
        existing.camera = camera;
        continue;
      }
      this.startTarget(camera);
    }
  }

  /**
   * Giải mã thử trong một khoảng thời gian. `cameraId` bỏ trống thì lấy
   * camera QR đầu tiên, kể cả bàn đang dùng súng quét — đúng như trước.
   */
  async testDecode(durationMs = 10_000, cameraId?: string): Promise<DecodedQr[]> {
    const camera =
      (cameraId && this.cameras.find((c) => c.camera_id === cameraId)) ||
      this.cameras.find((c) => c.role === "proof_qr" && c.station_id !== null) ||
      null;
    if (!camera) return [];

    const collector: TestCollector = { values: new Map() };
    this.testCollectors.add(collector);
    const startedForTest = !this.targets.has(camera.camera_id);
    this.testCameraId = camera.camera_id;
    if (startedForTest) this.startTarget(camera);

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    this.testCollectors.delete(collector);
    if (this.testCollectors.size === 0) this.testCameraId = null;
    const stillScanning = QrScanService.scanningCameras(this.cameras).some(
      (c) => c.camera_id === camera.camera_id,
    );
    if (startedForTest && !stillScanning && this.testCollectors.size === 0) {
      await this.stopTarget(camera.camera_id);
    }
    return [...collector.values.values()];
  }

  private relayPath(camera: CredentialItem): string {
    return relayPathName(camera.camera_code, camera.rtsp_substream_url ? "sub" : "main");
  }

  private startTarget(camera: CredentialItem): void {
    const pathName = this.relayPath(camera);
    const target: QrTarget = {
      camera,
      pathName,
      source: null,
      zone: new QrZone(this.options.confirmFrames, this.options.absenceMs),
      decoderBusy: false,
      lastMultipleWarningAt: 0,
    };
    this.targets.set(camera.camera_id, target);
    target.source = this.createSource(pathName, (frame, capturedAt) =>
      this.onFrame(target, frame, capturedAt),
    );
    target.source.start();
  }

  private async stopTarget(cameraId: string): Promise<void> {
    const target = this.targets.get(cameraId);
    if (!target) return;
    this.targets.delete(cameraId);
    const source = target.source;
    target.source = null;
    if (source) await source.stop();
  }

  private onFrame(target: QrTarget, frame: Uint8Array, capturedAt: Date): void {
    // Mỗi camera tự giữ cờ bận: một bàn giải mã chậm không được làm bàn
    // khác bỏ khung hình.
    if (target.decoderBusy) return;
    target.decoderBusy = true;
    void this.decode(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT)
      .then((decoded) => this.onDecoded(target, decoded, capturedAt))
      .catch((error) => {
        console.warn(
          `[qr-scan-service] camera=${target.camera.camera_code} decode failed: ${(error as Error).message}`,
        );
      })
      .finally(() => {
        target.decoderBusy = false;
      });
  }

  private onDecoded(target: QrTarget, decoded: DecodedQr[], capturedAt: Date): void {
    if (target.camera.camera_id === this.testCameraId) {
      for (const collector of this.testCollectors) {
        for (const value of decoded) collector.values.set(value.text, value);
      }
    }
    // Luồng mở tạm để thử giải mã thì không phát scan thật.
    if (target.camera.scan_source !== "camera" || target.camera.station_id === null) return;

    const result = target.zone.ingest(decoded, capturedAt);
    if (result.warning === "multiple_qr") {
      const now = Date.now();
      if (now - target.lastMultipleWarningAt >= this.options.absenceMs) {
        target.lastMultipleWarningAt = now;
        this.options.onWarning?.("multiple_qr");
      }
    }
    if (result.emission) {
      swallow(
        Promise.resolve(this.options.onScan({ camera: target.camera, emission: result.emission })),
        "qrScanService.onScan",
      );
    }
  }

  async stop(): Promise<void> {
    this.testCollectors.clear();
    this.testCameraId = null;
    await Promise.all([...this.targets.keys()].map((cameraId) => this.stopTarget(cameraId)));
  }
}
