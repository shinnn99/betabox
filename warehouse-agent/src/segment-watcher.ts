import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * Theo dõi thư mục camera để bắt segment file mới.
 *
 * Chiến lược: fs.watch cho phản hồi tức thời + poll fallback định kỳ
 * cho ca fs.watch miss event (bug historic trên Windows với một số
 * filesystem như SMB, virtualization).
 *
 * Vì sao chọn watch thư mục thay vì parse stderr ffmpeg: format log
 * ffmpeg đổi theo version (Lát 2 vừa dính `-rw_timeout` biến mất ở
 * 8.1). File system là source-of-truth vật lý, miễn nhiễm version.
 *
 * Ta chỉ báo event "opened" (file mới xuất hiện). Nội dung "segment
 * cũ vừa rolled" được suy bởi SegmentTracker khi thấy file mới xuất
 * hiện — nó tự đóng segment cũ. Ca file mới 0-byte không quan trọng
 * vì ta không đọc file mới đó ngay; ta chỉ dùng nó làm marker để
 * đóng segment cũ.
 */

export interface OpenedEvent {
  cameraId: string;
  cameraCode: string;
  sessionId: string | null;
  absPath: string;
}

type Emit = (event: OpenedEvent) => void;

interface WatchedCamera {
  cameraId: string;
  cameraCode: string;
  sessionId: string | null;
  cameraDir: string;
  watcher: FSWatcher | null;
  // Set các absPath đã emit — chống double-emit khi fs.watch + poll
  // cùng phát hiện một file.
  seen: Set<string>;
}

const MP4_RE = /\.mp4$/i;

export class SegmentWatcher {
  private readonly cameras = new Map<string, WatchedCamera>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly recordingRoot: string,
    private readonly pollIntervalMs: number,
    private readonly emit: Emit,
  ) {}

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const c of this.cameras.values()) {
      c.watcher?.close();
    }
    this.cameras.clear();
  }

  /**
   * Bắt đầu watch cho một camera. Gọi khi recording lifecycle spawn
   * ffmpeg thành công. Idempotent: gọi lại cho cùng cameraId chỉ đổi
   * sessionId, không tạo watcher mới.
   */
  async watchCamera(params: {
    cameraId: string;
    cameraCode: string;
    sessionId: string | null;
  }): Promise<void> {
    const existing = this.cameras.get(params.cameraId);
    if (existing) {
      existing.sessionId = params.sessionId;
      return;
    }

    const cameraDir = path.join(this.recordingRoot, sanitizeCode(params.cameraCode));

    // Prime `seen` với file cũ HIỆN CÓ trên ổ lúc start watch. Nếu
    // không prime, watcher + poll fallback sẽ emit event cho mọi file
    // cũ trong thư mục — sinh ra hàng chục dòng "rolled" giả và ghi
    // row rác vào DB.
    //
    // NGOẠI LỆ: file mới nhất theo tên (chronological) KHÔNG được
    // prime vào seen. Đây là "file ffmpeg đang mở lúc watchCamera
    // gọi" — cần được emit qua bình thường để tracker biết nó là
    // current segment. Nếu prime cả file này, tracker sẽ không nhận
    // biết được nó, và khi ffmpeg rolled sang file kế, tracker sẽ
    // không đóng file mới nhất này đúng cách → row của nó trong DB
    // giữ ended_at cũ (hoặc null) mãi mãi, làm bảng nói sai độ dài.
    //
    // Ffmpeg 8.1 -strftime tên file theo giây, luôn tăng monotonically
    // → file mới nhất = alphabetical last.
    //
    // Boot recovery (segment-index.bootRecovery) tách nhau: nó xử lý
    // file cũ trên ổ với parse tên file → started_at chuẩn, và bỏ
    // qua file đang được ghi (mtime gần now) — không đá nhau với
    // tracker live.
    // Ngưỡng "file đang được ffmpeg ghi": mtime cách now dưới ngưỡng
    // này thì KHÔNG prime → watcher emit qua bình thường → tracker
    // biết đó là current. Nếu prime cả file đang mở, khi ffmpeg
    // rolled sang file kế, tracker sẽ không đóng file đang mở đúng
    // cách — row DB giữ ended_at cũ (hoặc null), bảng nói sai độ dài.
    const ACTIVE_WRITE_THRESHOLD_MS = 20_000;
    const nowMs = Date.now();
    const priorFiles = new Set<string>();
    try {
      const found = await this.walkMp4(cameraDir);
      for (const f of found) {
        try {
          const st = await fs.stat(f);
          if (nowMs - st.mtimeMs < ACTIVE_WRITE_THRESHOLD_MS) {
            // File này ffmpeg đang ghi (mtime rất gần now). KHÔNG
            // prime — watcher sẽ emit và tracker sẽ track làm current.
            console.log(
              `[segment-watcher] not priming active-write file for ${params.cameraCode}: ${path.basename(f)}`,
            );
            continue;
          }
        } catch {
          // stat lỗi — coi như file cũ, prime an toàn
        }
        priorFiles.add(f);
      }
    } catch {
      // dir chưa tồn tại — không sao
    }

    let watcher: FSWatcher | null = null;
    try {
      // recursive:true để bắt file trong subdir YYYY/MM/DD. Không lo
      // scope quá rộng vì mỗi camera có thư mục riêng.
      watcher = watch(cameraDir, { recursive: true }, (eventType, fname) => {
        if (!fname) return;
        const relFromCamDir = String(fname);
        if (!MP4_RE.test(relFromCamDir)) return;
        const absPath = path.join(cameraDir, relFromCamDir);
        void this.considerFile(params.cameraId, absPath);
      });
    } catch (err) {
      // Dir chưa tồn tại là bình thường lúc start recording (ffmpeg
      // sẽ tạo). Poll sẽ đảm nhiệm.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `[segment-watcher] fs.watch failed for ${params.cameraCode}: ${(err as Error).message}`,
        );
      }
    }

    this.cameras.set(params.cameraId, {
      cameraId: params.cameraId,
      cameraCode: params.cameraCode,
      sessionId: params.sessionId,
      cameraDir,
      watcher,
      seen: priorFiles,
    });
    if (priorFiles.size > 0) {
      console.log(
        `[segment-watcher] priming ${params.cameraCode} with ${priorFiles.size} pre-existing file(s) (will not re-emit)`,
      );
    }
  }

  /**
   * Ngừng watch cho camera. Gọi khi stop_recording hoặc recording
   * exit không recovery (permanent error).
   */
  unwatchCamera(cameraId: string): void {
    const c = this.cameras.get(cameraId);
    if (!c) return;
    c.watcher?.close();
    this.cameras.delete(cameraId);
  }

  /**
   * Poll fallback: quét mọi thư mục camera đang watch, tìm file mới
   * mà fs.watch có thể đã miss.
   */
  private async pollAll(): Promise<void> {
    for (const c of this.cameras.values()) {
      try {
        await this.scanCameraDir(c);
      } catch (err) {
        console.warn(
          `[segment-watcher] poll scan failed ${c.cameraCode}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async scanCameraDir(c: WatchedCamera): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await this.walkMp4(c.cameraDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // dir chưa tồn tại
      throw err;
    }
    for (const abs of entries) {
      this.considerFile(c.cameraId, abs);
    }
  }

  private async walkMp4(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await this.walkMp4(full);
        out.push(...sub);
      } else if (MP4_RE.test(e.name)) {
        out.push(full);
      }
    }
    return out;
  }

  private considerFile(cameraId: string, absPath: string): void {
    const c = this.cameras.get(cameraId);
    if (!c) return;
    if (c.seen.has(absPath)) return;
    c.seen.add(absPath);
    this.emit({
      cameraId: c.cameraId,
      cameraCode: c.cameraCode,
      sessionId: c.sessionId,
      absPath,
    });
  }
}

function sanitizeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9_-]/g, "_");
}
