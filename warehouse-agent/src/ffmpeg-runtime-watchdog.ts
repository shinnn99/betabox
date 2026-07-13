import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cameraRecordingDir,
  isRecording,
  killRecordingProcessForRestart,
} from "./recording";

/**
 * Watchdog runtime — chống ca ffmpeg treo giữa ngày (không exit, không ghi).
 *
 * Cảnh:
 *   B2 boot recovery + 3 tầng retry (short/long/error_prolonged) đều KHÔNG
 *   cover ca ffmpeg treo mà không exit. Retry chỉ kích khi ffmpeg **exit**.
 *   Nếu ffmpeg TCP RTSP connect được (đủ để không SIGPIPE), rồi stall
 *   (camera treo, cáp lỏng, chuyển mạng giữa chừng) → agent Running, session
 *   `recording`, heartbeat tươi, dashboard "Đang ghi" — nhưng **0 byte mới
 *   ra ổ suốt cả ngày**. Âm thầm mất bằng chứng.
 *
 * Cơ chế:
 *   Mỗi cam mỗi checkIntervalMs (30s): quét thư mục segment hôm nay của
 *   cam, tìm file segment **đã đóng** (không phải file đang mở size=0)
 *   mới nhất. Nếu `now - mtime_file_đã_đóng_mới_nhất > staleThresholdMs`
 *   (segment_seconds × 2 + buffer, mặc định 150s cho segment 60s) →
 *   **kill ffmpeg qua `killRecordingProcessForRestart`**, KHÔNG tự spawn.
 *
 *   Kill = trigger onUnexpectedExit → retry layer đã có bắt → respawn qua
 *   đường spawn duy nhất, không đá với short-retry (một đường spawn).
 *
 * Cứng:
 *   - KHÔNG dùng mtime file đang mở (Windows không cập nhật realtime — đã
 *     verify 3 snapshot 2026-07-12). Chỉ nhìn file `size > 0` mtime chốt.
 *   - KHÔNG dùng cho boot (boot dùng B2 + declare, không cần watchdog).
 *   - KHÔNG tự spawn — chỉ kill, để retry layer là đường spawn duy nhất.
 *   - Skip cam chưa `isRecording()` (không có ffmpeg đang chạy → không có
 *     gì để watchdog).
 *   - Skip cam mới spawn dưới `graceStartMs` (30s) — segment đầu tiên
 *     chưa xoay, chưa có file đã đóng nào để so.
 */

export interface ActiveCameraInfo {
  cameraId: string;
  cameraCode: string;
  /** Segment seconds cho cam này (từ credentials cloud, mỗi cam có thể khác). */
  segmentSeconds: number;
}

export interface WatchdogDeps {
  recordingRoot: string;
  /**
   * Danh sách cam đang recording với segmentSeconds. Đọc từ
   * `listActiveRecordings().map(r => ({ cameraId, cameraCode, segmentSeconds }))`.
   */
  getActiveCameras: () => ActiveCameraInfo[];
}

export interface WatchdogOptions {
  /** Chu kỳ kiểm mỗi cam (ms). Mặc định 30_000. */
  checkIntervalMs?: number;
  /**
   * Multiplier cho ngưỡng stale. Ngưỡng = `segmentSeconds * multiplier * 1000
   * + bufferMs`. Mặc định 2 (60s segment → 120s + 30s buffer = 150s).
   */
  staleMultiplier?: number;
  /** Buffer thêm vào ngưỡng stale (ms). Mặc định 30_000. */
  staleBufferMs?: number;
  /**
   * Grace period sau spawn — không watchdog trong khoảng này. Multiplier
   * theo segmentSeconds. Mặc định 1 (60s + 30s buffer = 90s). Segment đầu
   * tiên chưa xoay xong → chưa có file đã đóng nào. Watchdog sớm sẽ false
   * positive.
   */
  graceMultiplier?: number;
  /** Buffer thêm vào grace (ms). Mặc định 30_000. */
  graceBufferMs?: number;
}

interface WatchdogState {
  /** Timestamp watchdog thấy cam lần đầu (approx spawn time). */
  firstSeenMs: number;
  /** Timestamp mtime file đã đóng mới nhất, để log nếu thấy tiến bộ. */
  lastGoodMtimeMs: number;
  /** Đếm số lần watchdog đã kill cho cam này (log debug). */
  killCount: number;
}

export class FfmpegRuntimeWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private stateByCameraId = new Map<string, WatchdogState>();
  private readonly checkIntervalMs: number;
  private readonly staleMultiplier: number;
  private readonly staleBufferMs: number;
  private readonly graceMultiplier: number;
  private readonly graceBufferMs: number;

  constructor(
    private readonly deps: WatchdogDeps,
    opts: WatchdogOptions = {},
  ) {
    this.checkIntervalMs = opts.checkIntervalMs ?? 30_000;
    this.staleMultiplier = opts.staleMultiplier ?? 2;
    this.staleBufferMs = opts.staleBufferMs ?? 30_000;
    this.graceMultiplier = opts.graceMultiplier ?? 1;
    this.graceBufferMs = opts.graceBufferMs ?? 30_000;
  }

  private staleThresholdMsFor(segmentSeconds: number): number {
    return segmentSeconds * this.staleMultiplier * 1000 + this.staleBufferMs;
  }

  private graceStartMsFor(segmentSeconds: number): number {
    return segmentSeconds * this.graceMultiplier * 1000 + this.graceBufferMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error(
          `[runtime-watchdog] tick error: ${(err as Error).message}`,
        );
      });
    }, this.checkIntervalMs);
    console.log(
      `[runtime-watchdog] started: check=${this.checkIntervalMs}ms stale_mult=${this.staleMultiplier}x+${this.staleBufferMs}ms grace_mult=${this.graceMultiplier}x+${this.graceBufferMs}ms`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stateByCameraId.clear();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const activeCameras = this.deps.getActiveCameras();
    const activeIds = new Set(activeCameras.map((c) => c.cameraId));

    // Cleanup state cho cam không còn recording (user stop hoặc permanent).
    for (const cid of Array.from(this.stateByCameraId.keys())) {
      if (!activeIds.has(cid)) this.stateByCameraId.delete(cid);
    }

    for (const cam of activeCameras) {
      // Chỉ watchdog cam đang thật sự có ffmpeg. isRecording bao gồm
      // startupSet nữa (đang spawn) — skip startup, chỉ xử recording ổn định.
      if (!isRecording(cam.cameraId)) continue;

      let state = this.stateByCameraId.get(cam.cameraId);
      if (!state) {
        state = { firstSeenMs: now, lastGoodMtimeMs: 0, killCount: 0 };
        this.stateByCameraId.set(cam.cameraId, state);
      }

      // Grace period sau spawn/lần thấy đầu — chưa có file đã đóng nào,
      // watchdog sớm sẽ false positive.
      const graceMs = this.graceStartMsFor(cam.segmentSeconds);
      if (now - state.firstSeenMs < graceMs) continue;

      const latestClosedMtimeMs = await this.findLatestClosedSegmentMtime(
        cam.cameraCode,
        now,
      );

      const staleMs = this.staleThresholdMsFor(cam.segmentSeconds);
      if (latestClosedMtimeMs === null) {
        // Không tìm thấy file đã đóng nào trong window quét. Có thể:
        //   (a) Cam mới spawn ~1 phút, chưa xoay segment đầu → grace sẽ
        //       cover. Nếu vượt grace mà vẫn 0 file đóng → bất thường, kill.
        //   (b) Ổ dir đã bị xóa/rename bất thường.
        console.warn(
          `[runtime-watchdog] cam=${cam.cameraCode} 0 closed segment in window — kill để retry layer xử`,
        );
        await this.killAndCount(cam, state);
        continue;
      }

      const ageMs = now - latestClosedMtimeMs;
      if (ageMs > staleMs) {
        console.warn(
          `[runtime-watchdog] cam=${cam.cameraCode} STALE age=${Math.round(ageMs / 1000)}s > threshold=${Math.round(staleMs / 1000)}s → kill để retry layer respawn`,
        );
        await this.killAndCount(cam, state);
      } else {
        state.lastGoodMtimeMs = latestClosedMtimeMs;
      }
    }
  }

  private async killAndCount(
    cam: ActiveCameraInfo,
    state: WatchdogState,
  ): Promise<void> {
    state.killCount++;
    const outcome = await killRecordingProcessForRestart(cam.cameraId);
    console.log(
      `[runtime-watchdog] kill cam=${cam.cameraCode} outcome=${JSON.stringify(outcome)} kill_count=${state.killCount}`,
    );
    // Reset firstSeenMs — sau kill, ffmpeg exit → onUnexpectedExit →
    // retry layer respawn. Grace period tính lại cho ffmpeg mới.
    state.firstSeenMs = Date.now();
  }

  /**
   * Tìm mtime của file segment ĐÃ ĐÓNG (size > 0) mới nhất trong thư mục
   * hôm nay của cam. KHÔNG nhìn file đang mở (size=0, mtime null trên
   * Windows). Trả null nếu không có file đã đóng nào.
   *
   * Chỉ scan thư mục ngày hôm nay + hôm qua (2 ngày) — đủ cover ca
   * qua nửa đêm. Không scan sâu 30 ngày (đó là boot recovery, không phải
   * runtime check).
   */
  private async findLatestClosedSegmentMtime(
    cameraCode: string,
    now: number,
  ): Promise<number | null> {
    const camDir = cameraRecordingDir(this.deps.recordingRoot, cameraCode);
    const today = new Date(now);
    const yesterday = new Date(now - 86_400_000);

    let latest = 0;
    for (const d of [today, yesterday]) {
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const dayDir = path.join(camDir, yyyy, mm, dd);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dayDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!/\.mp4$/i.test(e.name)) continue;
        const full = path.join(dayDir, e.name);
        try {
          const st = await fs.stat(full);
          // File đang mở của ffmpeg: size = 0 trên Windows (không flush
          // header cho tới khi xoay segment). Chỉ tin file size > 0.
          if (st.size <= 0) continue;
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        } catch {
          // ignore
        }
      }
    }
    return latest > 0 ? latest : null;
  }
}
