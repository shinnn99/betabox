import { promises as fs } from "node:fs";
import path from "node:path";
import {
  postRecordingFiles,
  fetchKnownRecordingFiles,
  type SegmentFilePayload,
} from "./commands";
import { SegmentTracker } from "./segment-tracker";
import { SegmentWatcher, type OpenedEvent } from "./segment-watcher";
import {
  SegmentReportQueue,
  type QueuedReport,
} from "./segment-report-queue";

/**
 * Orchestrator: gộp watcher + tracker + queue + boot recovery thành
 * một interface đơn giản cho recording-lifecycle gọi.
 *
 * Public API:
 *   - start(): bắt đầu poll fallback + flush timer.
 *   - stop(): shutdown.
 *   - onRecordingStarted({cameraId, cameraCode, sessionId}): gọi khi
 *     ffmpeg vừa spawn ổn định. Watcher bắt đầu theo dõi thư mục
 *     camera này.
 *   - onRecordingStopped({cameraId}): gọi khi ffmpeg vừa exit (stop
 *     chủ động hoặc crash). Watcher ngừng theo dõi, tracker đóng
 *     segment đang mở.
 *   - bootRecovery(cameras): sau khi lifecycle boot xong, scan ổ
 *     RECOVERY_SCAN_DAYS ngày về trước, so với known từ cloud,
 *     upsert những gì thiếu.
 */

export interface CameraInfo {
  cameraId: string;
  cameraCode: string;
  sessionId: string | null;
}

export interface SegmentIndexDeps {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  recordingRoot: string;
  segmentWatchPollMs: number;
  recoveryScanDays: number;
  queuePath: string;
}

const FLUSH_INTERVAL_MS = 5000;
const BATCH_SIZE = 50;

export class SegmentIndex {
  private readonly tracker: SegmentTracker;
  private readonly watcher: SegmentWatcher;
  private readonly queue: SegmentReportQueue;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SegmentIndexDeps) {
    this.tracker = new SegmentTracker(deps.recordingRoot);
    this.queue = new SegmentReportQueue(deps.queuePath);
    this.watcher = new SegmentWatcher(
      deps.recordingRoot,
      deps.segmentWatchPollMs,
      (event) => this.onOpened(event),
    );
  }

  start(): void {
    this.watcher.start();
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flushQueue();
    }, FLUSH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.watcher.stop();
  }

  async onRecordingStarted(info: CameraInfo): Promise<void> {
    await this.watcher.watchCamera(info);
  }

  /**
   * Gọi khi ffmpeg cũ vừa exit nhưng recording sẽ respawn (Lát 2
   * short retry). Đóng segment đang mở nhưng GIỮ watcher tiếp tục
   * theo dõi thư mục — file mới do ffmpeg mới tạo ra sẽ được bắt.
   */
  async onFfmpegExitedForRespawn(cameraId: string): Promise<void> {
    const payload = await this.tracker.closeCurrent(cameraId);
    if (payload) {
      await this.sendOrQueue([payload]);
    }
  }

  /**
   * Gọi khi camera thật sự ngừng ghi (stop chủ động, hoặc permanent
   * error không respawn nữa). Đóng segment cuối + tháo watcher.
   */
  async onRecordingStopped(cameraId: string): Promise<void> {
    const payload = await this.tracker.closeCurrent(cameraId);
    this.watcher.unwatchCamera(cameraId);
    if (payload) {
      await this.sendOrQueue([payload]);
    }
  }

  private async onOpened(event: OpenedEvent): Promise<void> {
    try {
      const payloads = await this.tracker.onSegmentOpened({
        cameraId: event.cameraId,
        sessionId: event.sessionId,
        absPath: event.absPath,
      });
      if (payloads.length === 0) return;
      console.log(
        `[segment-index] rolled camera=${event.cameraCode} file=${path.basename(event.absPath)} (${payloads.length} payload(s))`,
      );
      await this.sendOrQueue(payloads);
    } catch (err) {
      console.error(
        `[segment-index] onOpened failed camera=${event.cameraCode}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Boot recovery: scan RECOVERY_SCAN_DAYS ngày ổ, so với known từ
   * cloud, upsert những gì thiếu. Gọi sau khi lifecycle.boot() xong
   * (cần biết camera nào đang được ghi).
   *
   * Ngưỡng RECOVERY_SCAN_DAYS: giả định agent không offline quá số
   * ngày này. Segment cũ hơn không được backfill (BLOCKS-GO-LIVE
   * trong config.ts).
   */
  async bootRecovery(cameras: CameraInfo[]): Promise<void> {
    if (cameras.length === 0) {
      console.log("[segment-index] boot recovery: no cameras, skip");
      return;
    }
    const now = new Date();
    const sinceMs = now.getTime() - this.deps.recoveryScanDays * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();

    // 1) Scan ổ cho mọi camera.
    // Boot recovery là NGOẠI LỆ so với chính sách "không parse tên
    // file để so mốc": file đã tồn tại từ trước, mtime là "lần cuối
    // viết" ≠ "bắt đầu ghi". Ta phải parse tên file để suy
    // started_at. Convert local time → UTC bằng constructor
    // `new Date(y, m-1, d, ...)` — Node dùng TZ hệ thống lúc gọi,
    // ISO output là UTC. Miễn TZ hệ thống lúc boot recovery giống
    // TZ lúc ffmpeg tạo file (thường là vậy vì cùng máy), map đúng.
    const diskFiles: Array<{
      cameraInfo: CameraInfo;
      absPath: string;
      relPath: string;
      fileName: string;
      startedAt: string;
      sizeBytes: number;
    }> = [];
    for (const cam of cameras) {
      const cameraDir = path.join(this.deps.recordingRoot, sanitizeCode(cam.cameraCode));
      const found = await scanDirForMp4(cameraDir, new Date(sinceMs));
      for (const f of found) {
        const parsed = parseSegmentFilename(path.basename(f.absPath));
        if (!parsed) continue; // file lạ (không phải segment format), skip
        diskFiles.push({
          cameraInfo: cam,
          absPath: f.absPath,
          relPath: path.relative(this.deps.recordingRoot, f.absPath).replaceAll("\\", "/"),
          fileName: path.basename(f.absPath),
          startedAt: parsed.startedAt.toISOString(),
          sizeBytes: f.size,
        });
      }
    }
    if (diskFiles.length === 0) {
      console.log("[segment-index] boot recovery: no mp4 files on disk within window");
      return;
    }

    // 2) Hỏi cloud danh sách đã biết. Giữ cả ended_at để phát hiện
    // row known có ended_at=null (mồ côi vì tracker cũ chết giữa
    // chừng) và update nó với started_at của file kế tiếp.
    let known: Map<string, { ended_at: string | null }>;
    try {
      const list = await fetchKnownRecordingFiles({
        backendUrl: this.deps.backendUrl,
        agentCode: this.deps.agentCode,
        agentSecret: this.deps.agentSecret,
        cameraIds: cameras.map((c) => c.cameraId),
        sinceIso,
      });
      known = new Map(
        list.map((f) => [`${f.camera_id}|${f.file_path}`, { ended_at: f.ended_at }]),
      );
    } catch (err) {
      console.error(
        `[segment-index] boot recovery: fetch known failed (${(err as Error).message}); queueing all disk files for retry`,
      );
      known = new Map(); // fallback: enqueue mọi file — flush sẽ retry sau
    }

    // 3) Diff: file trên ổ mà cloud không biết → upsert.
    // File cuối cùng theo mtime của mỗi camera là "đang ghi" — báo
    // ended_at=null, còn lại báo ended_at = mtime.
    const missing: SegmentFilePayload[] = [];
    // Group theo camera để xác định "cái nào mới nhất".
    const byCamera = new Map<string, typeof diskFiles>();
    for (const df of diskFiles) {
      const arr = byCamera.get(df.cameraInfo.cameraId) ?? [];
      arr.push(df);
      byCamera.set(df.cameraInfo.cameraId, arr);
    }
    // Ngưỡng "file đang được ffmpeg ghi": mtime cách now dưới ngưỡng
    // này thì bỏ qua trong boot recovery — vì mtime của file đang mở
    // thay đổi liên tục, snapshot mtime bây giờ không phản ánh
    // ended_at thật. Tracker live sẽ đóng file này đúng cách khi
    // ffmpeg rolled sang file kế. 20s > segment thông thường ~1s
    // per frame, đủ chắc để phân biệt "file đang ghi" vs "file đã
    // đóng ≥ 20s".
    const ACTIVE_WRITE_THRESHOLD_MS = 20_000;
    const nowMs = Date.now();

    for (const [, arr] of byCamera) {
      arr.sort((a, b) => a.absPath.localeCompare(b.absPath));
      const lastIdx = arr.length - 1;
      for (let i = 0; i < arr.length; i++) {
        const df = arr[i];
        const key = `${df.cameraInfo.cameraId}|${df.relPath}`;
        const knownEntry = known.get(key);
        // Skip nếu đã known VÀ đã có ended_at. Nếu known nhưng
        // ended_at=null (tracker cũ chết giữa chừng, để mồ côi),
        // vẫn phải cập nhật với ended_at = started_at của file kế
        // tiếp (nếu có).
        if (knownEntry && knownEntry.ended_at !== null) continue;
        // Nếu KHÔNG phải file mới nhất → dùng started_at của file
        // kế tiếp làm ended_at.
        let endedAtIso: string | null = null;
        let duration: number | null = null;
        if (i < lastIdx) {
          // ended_at cần đúng ngữ nghĩa "lúc file này ngừng được
          // ghi", không phải "lúc file kế tiếp mở". Nếu hai file
          // liền kề trong thời gian (ffmpeg thật sự rolled), mtime
          // của file này ≈ started_at của file kế. NHƯNG nếu ffmpeg
          // exit giữa chừng và spawn lại sau 14 phút, mtime cho biết
          // đúng lúc ffmpeg exit — dùng started_at của next sẽ nói
          // sai "segment này ghi 14 phút" trong khi file chỉ có 30s
          // video.
          //
          // Dùng min(mtime, next.started_at) — an toàn cho cả hai
          // trường hợp: rolled bình thường (mtime ≈ next.started ≈
          // đúng), và ffmpeg gap (mtime = lúc exit thật, dùng cái đó).
          const st = await fs.stat(df.absPath).catch(() => null);
          const nextStartMs = Date.parse(arr[i + 1].startedAt);
          const endedMs = st
            ? Math.min(st.mtimeMs, nextStartMs)
            : nextStartMs;
          endedAtIso = new Date(endedMs).toISOString();
          duration = Math.max(
            0,
            Math.round((endedMs - Date.parse(df.startedAt)) / 1000),
          );
        } else {
          // File mới nhất trong danh sách. HAI ca:
          //   (A) File đang được ffmpeg ghi (mtime rất gần now) → BỎ QUA
          //       hoàn toàn. Nếu upsert, ended_at = mtime bây giờ sẽ
          //       chốt row sai độ dài — ffmpeg vẫn còn ghi thêm 40s
          //       nữa vào file này. Bug _114833=17s là ca đó. Tracker
          //       live sẽ handle file này khi rolled sang file kế.
          //   (B) File đã đóng lâu (mtime cách now ≥ ngưỡng) →
          //       ended_at = mtime, an toàn.
          const st = await fs.stat(df.absPath).catch(() => null);
          if (!st) continue;
          const ageMs = nowMs - st.mtimeMs;
          if (ageMs < ACTIVE_WRITE_THRESHOLD_MS) {
            console.log(
              `[segment-index] boot recovery: skip active-write file ${df.relPath} (mtime ${Math.round(ageMs)}ms ago) — tracker will handle`,
            );
            continue;
          }
          endedAtIso = new Date(st.mtimeMs).toISOString();
          duration = Math.max(
            0,
            Math.round((st.mtimeMs - Date.parse(df.startedAt)) / 1000),
          );
        }
        missing.push({
          camera_id: df.cameraInfo.cameraId,
          session_id: df.cameraInfo.sessionId,
          file_path: df.relPath,
          file_name: df.fileName,
          started_at: df.startedAt,
          ended_at: endedAtIso,
          duration_seconds: duration,
          file_size_bytes: df.sizeBytes,
        });
      }
    }

    if (missing.length === 0) {
      console.log("[segment-index] boot recovery: all disk files already known");
      return;
    }
    console.log(
      `[segment-index] boot recovery: backfilling ${missing.length} file(s) not yet in cloud`,
    );
    await this.sendOrQueue(missing);
  }

  /**
   * Gửi luôn nếu được, còn lỗi/rớt thì queue để flush timer retry.
   */
  private async sendOrQueue(payloads: SegmentFilePayload[]): Promise<void> {
    if (payloads.length === 0) return;
    const chunks: SegmentFilePayload[][] = [];
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      chunks.push(payloads.slice(i, i + BATCH_SIZE));
    }
    for (const chunk of chunks) {
      const r = await postRecordingFiles({
        backendUrl: this.deps.backendUrl,
        agentCode: this.deps.agentCode,
        agentSecret: this.deps.agentSecret,
        files: chunk,
      });
      if (!r.ok) {
        await this.queue.appendMany(chunk);
        console.warn(
          `[segment-index] post failed http=${r.status}, queued ${chunk.length} file(s) for retry`,
        );
      } else if (r.collisions && r.collisions.length > 0) {
        // Log warn đỏ — không silent. Nếu thấy nhiều, đổi ffmpeg
        // pattern thêm %3N như comment trong recording-files/route.ts.
        console.warn(
          `[segment-index] SEGMENT_COLLISION on ${r.collisions.length} file(s): ${r.collisions.join(", ")}`,
        );
      }
    }
  }

  private async flushQueue(): Promise<void> {
    let items: QueuedReport[] = [];
    try {
      items = await this.queue.readAll();
    } catch {
      return;
    }
    if (items.length === 0) return;

    // Group thành batch để gửi.
    const remaining: QueuedReport[] = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);
      const r = await postRecordingFiles({
        backendUrl: this.deps.backendUrl,
        agentCode: this.deps.agentCode,
        agentSecret: this.deps.agentSecret,
        files: chunk.map((c) => c.payload),
      });
      if (!r.ok) {
        for (const c of chunk) remaining.push({ ...c, attempt: c.attempt + 1 });
      } else if (r.collisions && r.collisions.length > 0) {
        console.warn(
          `[segment-index] SEGMENT_COLLISION on flush: ${r.collisions.join(", ")}`,
        );
      }
    }
    try {
      await this.queue.rewrite(remaining);
    } catch (err) {
      console.error(
        `[segment-index] queue rewrite failed: ${(err as Error).message}`,
      );
    }
  }
}

function sanitizeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const FILENAME_RE = /^([A-Za-z0-9_-]+)_(\d{8})_(\d{6})\.mp4$/;

function parseSegmentFilename(fileName: string): { startedAt: Date } | null {
  const m = FILENAME_RE.exec(fileName);
  if (!m) return null;
  const [, , ymd, hms] = m;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const hour = Number(hms.slice(0, 2));
  const minute = Number(hms.slice(2, 4));
  const second = Number(hms.slice(4, 6));
  // Constructor `new Date(y, m-1, d, h, mi, s)` dùng TZ hệ thống.
  // toISOString() output UTC. Đây là chỗ DUY NHẤT trong 3a-1 parse
  // tên file — ngoại lệ boot recovery, không lan sang tracker live.
  const d = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(d.getTime())) return null;
  return { startedAt: d };
}

interface DiskFile {
  absPath: string;
  mtimeMs: number;
  size: number;
  durationHintSeconds?: number;
}

async function scanDirForMp4(dir: string, since: Date): Promise<DiskFile[]> {
  const out: DiskFile[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await scanDirForMp4(full, since);
      out.push(...sub);
    } else if (/\.mp4$/i.test(e.name)) {
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < since.getTime()) continue;
        out.push({ absPath: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // ignore
      }
    }
  }
  return out;
}
