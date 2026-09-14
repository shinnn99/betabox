import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stripNoisyFfmpegLines } from "../recording";

export const QR_FRAME_WIDTH = 640;
export const QR_FRAME_HEIGHT = 360;
const RESTART_DELAY_MS = 2_000;

export function buildQrFrameArgs(pathName: string, frameRate: number): string[] {
  if (!/^[a-z0-9]+$/.test(pathName)) {
    throw new Error(`Invalid QR relay path: ${pathName}`);
  }
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-rtsp_transport",
    "tcp",
    "-i",
    `rtsp://127.0.0.1:8554/${pathName}`,
    "-an",
    "-vf",
    `fps=${frameRate},scale=${QR_FRAME_WIDTH}:${QR_FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${QR_FRAME_WIDTH}:${QR_FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=gray`,
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

export class QrFrameSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private active = false;
  private pending = Buffer.alloc(0);

  constructor(
    private readonly ffmpegBin: string,
    private readonly pathName: string,
    private readonly frameRate: number,
    private readonly onFrame: (frame: Uint8Array, capturedAt: Date) => void,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.spawn();
  }

  private spawn(): void {
    if (!this.active || this.child) return;
    this.pending = Buffer.alloc(0);
    const child = spawn(this.ffmpegBin, buildQrFrameArgs(this.pathName, this.frameRate), {
      windowsHide: true,
      stdio: "pipe",
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const clean = stripNoisyFfmpegLines(chunk.toString("utf8")).trim();
      if (clean) console.warn(`[qr-frame-source] ${clean.slice(-1_000)}`);
    });
    child.once("error", (error) => {
      console.error(`[qr-frame-source] spawn failed: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.active) return;
      console.warn(
        `[qr-frame-source] exited code=${code ?? "null"} signal=${signal ?? "none"}; restarting`,
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawn();
      }, RESTART_DELAY_MS);
      this.restartTimer.unref();
    });
  }

  private consume(chunk: Buffer): void {
    // Luôn drain stdout. Nếu decoder phía trên đang bận, callback tự bỏ
    // frame; source vẫn cắt hết frame khỏi buffer để ffmpeg không bị nghẽn.
    this.pending = Buffer.concat([this.pending, chunk]);
    const frameBytes = QR_FRAME_WIDTH * QR_FRAME_HEIGHT;
    while (this.pending.byteLength >= frameBytes) {
      const frame = this.pending.subarray(0, frameBytes);
      this.pending = this.pending.subarray(frameBytes);
      this.onFrame(frame, new Date());
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
