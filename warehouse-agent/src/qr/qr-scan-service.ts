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

export class QrScanService {
  private cameras: CredentialItem[] = [];
  private target: CredentialItem | null = null;
  private source: QrFrameSource | null = null;
  private sourcePath: string | null = null;
  private decoderBusy = false;
  private zone: QrZone;
  private normalEnabled = false;
  private readonly testCollectors = new Set<TestCollector>();
  private lastMultipleWarningAt = 0;

  constructor(
    private readonly options: {
      ffmpegBin: string;
      frameRate: number;
      confirmFrames: number;
      absenceMs: number;
      onScan: (scan: CameraQrScan) => Promise<void> | void;
      onWarning?: (warning: "multiple_qr") => void;
    },
  ) {
    this.zone = new QrZone(options.confirmFrames, options.absenceMs);
  }

  async reconcile(cameras: CredentialItem[]): Promise<void> {
    this.cameras = [...cameras];
    const next = this.cameras.find(
      (camera) => camera.role === "proof_qr" && camera.station_id !== null,
    ) ?? null;
    const nextEnabled = next?.scan_source === "camera";
    const nextPath = next ? this.relayPath(next) : null;
    const changed = next?.camera_id !== this.target?.camera_id || nextPath !== this.sourcePath;
    this.target = next;
    this.normalEnabled = nextEnabled;

    if (changed) {
      await this.stopSource();
      this.zone = new QrZone(this.options.confirmFrames, this.options.absenceMs);
    }
    if (next && (nextEnabled || this.testCollectors.size > 0)) {
      this.startSource(next);
    } else if (!nextEnabled && this.testCollectors.size === 0) {
      await this.stopSource();
    }
  }

  async testDecode(durationMs = 10_000): Promise<DecodedQr[]> {
    if (!this.target) return [];
    const collector: TestCollector = { values: new Map() };
    this.testCollectors.add(collector);
    this.startSource(this.target);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    this.testCollectors.delete(collector);
    if (!this.normalEnabled && this.testCollectors.size === 0) {
      await this.stopSource();
    }
    return [...collector.values.values()];
  }

  private relayPath(camera: CredentialItem): string {
    return relayPathName(camera.camera_code, camera.rtsp_substream_url ? "sub" : "main");
  }

  private startSource(camera: CredentialItem): void {
    const pathName = this.relayPath(camera);
    if (this.source && this.sourcePath === pathName) return;
    if (this.source) swallow(this.stopSource(), "qrScanService.stopChangedSource");
    this.sourcePath = pathName;
    this.source = new QrFrameSource(
      this.options.ffmpegBin,
      pathName,
      this.options.frameRate,
      (frame, capturedAt) => this.onFrame(frame, capturedAt),
    );
    this.source.start();
  }

  private onFrame(frame: Uint8Array, capturedAt: Date): void {
    if (this.decoderBusy) return;
    this.decoderBusy = true;
    void decodeGrayFrame(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT)
      .then((decoded) => this.onDecoded(decoded, capturedAt))
      .catch((error) => {
        console.warn(`[qr-scan-service] decode failed: ${(error as Error).message}`);
      })
      .finally(() => {
        this.decoderBusy = false;
      });
  }

  private onDecoded(decoded: DecodedQr[], capturedAt: Date): void {
    for (const collector of this.testCollectors) {
      for (const value of decoded) collector.values.set(value.text, value);
    }
    if (!this.normalEnabled || !this.target) return;
    const result = this.zone.ingest(decoded, capturedAt);
    if (result.warning === "multiple_qr") {
      const now = Date.now();
      if (now - this.lastMultipleWarningAt >= this.options.absenceMs) {
        this.lastMultipleWarningAt = now;
        this.options.onWarning?.("multiple_qr");
      }
    }
    if (result.emission) {
      swallow(
        Promise.resolve(this.options.onScan({ camera: this.target, emission: result.emission })),
        "qrScanService.onScan",
      );
    }
  }

  private async stopSource(): Promise<void> {
    const source = this.source;
    this.source = null;
    this.sourcePath = null;
    if (source) await source.stop();
  }

  async stop(): Promise<void> {
    this.normalEnabled = false;
    this.testCollectors.clear();
    await this.stopSource();
  }
}
