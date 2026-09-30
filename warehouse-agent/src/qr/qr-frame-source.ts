import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stripNoisyFfmpegLines } from "../recording";
import { RollingCounter } from "../log-noise";
import { tuning } from "../runtime-tuning";

/**
 * Cỡ khung hình đưa vào bộ giải mã.
 *
 * Tới 23/09/2026 đây là con số ÉP CỨNG 640x360, và nó là lý do mã QR nhỏ
 * (nhãn TikTok) không đọc được: camera phát 2K nhưng agent tự bóp xuống
 * 640 bề ngang, nên một mã 12mm chỉ còn ~12 pixel — chưa tới nửa pixel cho
 * mỗi ô vuông của mã. Không bộ giải mã nào đọc nổi.
 *
 * Giờ agent DÒ độ phân giải thật của camera (ffprobe) và đọc ở đúng cỡ đó,
 * chỉ thu nhỏ khi vượt trần dưới đây.
 *
 * Trần từng đặt 2560x1440 kèm ghi chú "giải mã không phải chỗ tốn: 1920
 * mất 17ms, 2560 mất 31ms". ĐO LẠI 30/09/2026 cho thấy con số đó sai hơn
 * mười lần — khung TRỐNG (cảnh ~99% thời gian, và là khung đắt nhất vì bộ
 * giải mã phải quét cạn ảnh mới dám kết luận) mất 166ms ở 2560x1440 và
 * 91ms ở 1920x1080, trong khi ngân sách chỉ có 100ms mỗi khung.
 *
 * Hạ trần về 1920x1080. Đây là SÀN, không phải số chọn bừa: đo ở 1600x900
 * thì mã TikTok 12mm không còn đọc được nữa — đúng lỗi mà bản 24/09 sinh
 * ra để sửa. Cùng với bộ giải mã hai pha (xem qr-decoder.ts), khung trống
 * giờ chỉ còn ~16ms.
 *
 * Hai hằng số này chỉ còn là TRẦN và là số dự phòng khi ffprobe không trả
 * lời. Đổi bằng biến môi trường — xem config.ts.
 */
export const QR_FRAME_WIDTH = 1920;
export const QR_FRAME_HEIGHT = 1080;
/** Dùng khi không dò được độ phân giải camera. */
export const QR_FALLBACK_WIDTH = 1280;
export const QR_FALLBACK_HEIGHT = 720;
const RESTART_DELAY_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Thu cỡ khung về vừa trần, giữ nguyên tỉ lệ và KHÔNG bao giờ phóng to —
 * phóng to chỉ tốn CPU mà không thêm một chi tiết nào.
 *
 * Chiều rộng/cao luôn chẵn: bộ lọc của ffmpeg đòi số chẵn.
 */
export function fitWithinCap(
  native: FrameSize,
  cap: FrameSize = { width: QR_FRAME_WIDTH, height: QR_FRAME_HEIGHT },
): FrameSize {
  if (native.width <= 0 || native.height <= 0) {
    return { width: QR_FALLBACK_WIDTH, height: QR_FALLBACK_HEIGHT };
  }
  const ratio = Math.min(cap.width / native.width, cap.height / native.height, 1);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(native.width * ratio), height: even(native.height * ratio) };
}

/** Độ phân giải thật của luồng — hỏi ffprobe, im lặng trả null nếu hỏng. */
export async function probeStreamSize(
  ffprobeBin: string,
  pathName: string,
): Promise<FrameSize | null> {
  if (!/^[a-z0-9]+$/.test(pathName)) {
    throw new Error(`Invalid QR relay path: ${pathName}`);
  }
  return probeTargetSize(ffprobeBin, `rtsp://127.0.0.1:8554/${pathName}`);
}

/** Hỏi ffprobe cỡ ảnh của một nguồn bất kỳ. Tách ra để test bằng file thật. */
export async function probeTargetSize(
  ffprobeBin: string,
  target: string,
): Promise<FrameSize | null> {
  const args = [
    "-v",
    "error",
    "-rtsp_transport",
    "tcp",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    target,
  ];
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      ffprobeBin,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
  if (!out) return null;
  const match = /(\d+)\s*,\s*(\d+)/.exec(out);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function buildQrFrameArgs(
  pathName: string,
  frameRate: number,
  width: number = QR_FALLBACK_WIDTH,
  height: number = QR_FALLBACK_HEIGHT,
): string[] {
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
    `fps=${frameRate},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=gray`,
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
  /** Cỡ khung đang đọc. Chỉ biết chắc sau khi dò xong camera. */
  private size: FrameSize;
  /**
   * 0.13.0: nhiễu giải mã ffmpeg thành TỈ LỆ (bản tự khai: khung hỏng / giờ)
   * thay vì một dòng log mỗi mẩu stderr — một nguồn từng chiếm 20.948 /
   * 26.990 dòng log một tuần ở một kho.
   */
  private readonly badFrames = new RollingCounter();
  private noiseWindowStartMs = 0;
  private noiseSuppressed = 0;

  constructor(
    private readonly ffmpegBin: string,
    private readonly pathName: string,
    private readonly frameRate: number,
    private readonly onFrame: (frame: Uint8Array, capturedAt: Date, size: FrameSize) => void,
    private readonly cap: FrameSize = { width: QR_FRAME_WIDTH, height: QR_FRAME_HEIGHT },
    private readonly ffprobeBin: string | null = null,
  ) {
    this.size = { width: QR_FALLBACK_WIDTH, height: QR_FALLBACK_HEIGHT };
  }

  /** Số mẩu lỗi giải mã trong 60 phút qua — cho bản tự khai. */
  badFramesLastHour(): number {
    return this.badFrames.lastHour();
  }

  /**
   * Lần đầu trong khoảng: ghi log (lỗi mới thì phải thấy ngay). Trong khoảng:
   * chỉ đếm. Sang khoảng mới: một dòng tóm tắt khoảng trước rồi mở khoảng
   * mới. Khoảng nhận từ cloud (`tuning.qrNoiseWindowMs`).
   */
  private onNoise(clean: string): void {
    this.badFrames.record();
    const now = Date.now();
    if (now - this.noiseWindowStartMs < tuning.qrNoiseWindowMs) {
      this.noiseSuppressed++;
      return;
    }
    if (this.noiseSuppressed > 0) {
      const minutes = Math.max(1, Math.round((now - this.noiseWindowStartMs) / 60_000));
      console.warn(
        `[qr-frame-source] ${this.pathName}: thêm ${this.noiseSuppressed} mẩu lỗi giải mã trong ${minutes} phút (đã gom)`,
      );
    }
    this.noiseWindowStartMs = now;
    this.noiseSuppressed = 0;
    console.warn(`[qr-frame-source] ${this.pathName}: ${clean.slice(-500)}`);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.resolveSizeThenSpawn();
  }

  /**
   * Dò độ phân giải camera TRƯỚC khi đọc, để không tự bóp mất chi tiết.
   * Dò hỏng thì vẫn chạy với cỡ dự phòng — thà đọc được mã to còn hơn im
   * lặng chờ ffprobe.
   */
  private async resolveSizeThenSpawn(): Promise<void> {
    if (this.ffprobeBin) {
      try {
        const native = await probeStreamSize(this.ffprobeBin, this.pathName);
        if (native) {
          this.size = fitWithinCap(native, this.cap);
          console.log(
            `[qr-frame-source] ${this.pathName}: camera ${native.width}x${native.height} -> doc QR o ${this.size.width}x${this.size.height}`,
          );
        } else {
          console.warn(
            `[qr-frame-source] ${this.pathName}: khong do duoc do phan giai, dung ${this.size.width}x${this.size.height}`,
          );
        }
      } catch (error) {
        console.warn(`[qr-frame-source] probe failed: ${(error as Error).message}`);
      }
    }
    if (!this.active) return;
    this.spawn();
  }

  private spawn(): void {
    if (!this.active || this.child) return;
    this.pending = Buffer.alloc(0);
    const child = spawn(
      this.ffmpegBin,
      buildQrFrameArgs(this.pathName, this.frameRate, this.size.width, this.size.height),
      {
        windowsHide: true,
        stdio: "pipe",
      },
    );
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const clean = stripNoisyFfmpegLines(chunk.toString("utf8")).trim();
      if (clean) this.onNoise(clean);
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
    const frameBytes = this.size.width * this.size.height;
    while (this.pending.byteLength >= frameBytes) {
      const frame = this.pending.subarray(0, frameBytes);
      this.pending = this.pending.subarray(frameBytes);
      this.onFrame(frame, new Date(), this.size);
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
