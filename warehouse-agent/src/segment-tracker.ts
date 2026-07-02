import { promises as fs } from "node:fs";
import path from "node:path";
import type { SegmentFilePayload } from "./commands";

/**
 * RAM state của "camera này đang ghi segment nào". Cùng với
 * segment-watcher, đây là consumer của filesystem events và producer
 * của SegmentReport gửi lên cloud.
 *
 * BLOCKS-GO-LIVE (NTP): started_at/ended_at đều dùng UTC. NHƯNG lệ
 * thuộc vào clock máy agent đúng. Không sync NTP → mọi timestamp
 * lệch, kéo theo cắt clip (3a-2) lệch. Chưa enforce ở agent, phải
 * cấu hình NTP trên máy kho trước go-live.
 *
 * Ngữ nghĩa timestamp (đã sửa sau bug 3):
 *   started_at = PARSE TỪ TÊN FILE (ffmpeg -strftime local time),
 *     convert sang UTC bằng new Date(y,m,d,h,mi,s).toISOString().
 *     Đây là mốc CHÍNH XÁC lúc ffmpeg mở file (ffmpeg dùng strftime
 *     giây, xác định tại open time). KHÔNG dùng "lúc watcher quan
 *     sát" vì watcher có thể chậm vài chục giây với ffmpeg thật khi:
 *       - Watchdog 20s (agent chờ ffmpeg ổn định trước khi
 *         onRecordingStarted → watchCamera).
 *       - Agent restart trong lúc ffmpeg vẫn ghi.
 *       - fs.watch fire chậm trên SMB/virtualization.
 *     Nếu dùng "watcher observed", started_at lệch 20-30s so với
 *     hiện thực → bảng nói sai độ dài segment, 3a-2 báo gap giả.
 *   ended_at = started_at của segment KẾ TIẾP (parse tên file kế
 *     tiếp). Segment mở (đang ghi) có ended_at=null. Khi ffmpeg
 *     exit (stop hoặc crash), closeCurrent() dùng now vì không có
 *     file kế để đối chiếu.
 */
export interface CurrentSegment {
  cameraId: string;
  sessionId: string | null;
  filePath: string; // relative to recordingRoot
  fileName: string;
  absPath: string;
  startedAt: string; // ISO UTC
}

export class SegmentTracker {
  private readonly currentByCamera = new Map<string, CurrentSegment>();

  constructor(private readonly recordingRoot: string) {}

  getCurrent(cameraId: string): CurrentSegment | undefined {
    return this.currentByCamera.get(cameraId);
  }

  hasCamera(cameraId: string): boolean {
    return this.currentByCamera.has(cameraId);
  }

  /**
   * Xử lý sự kiện "watcher thấy file mới cho camera này".
   *
   * Trả về mảng SegmentFilePayload cần gửi cloud:
   *   - Nếu có segment trước → 1 payload đóng segment cũ + 1 payload mở segment mới.
   *   - Nếu chưa có segment nào → chỉ 1 payload mở segment mới.
   *
   * Kiểm collision: nếu file mới cùng path với current (cùng camera)
   * thì bỏ qua — đó là event trùng lặp từ watcher, không phải rolled.
   */
  async onSegmentOpened(params: {
    cameraId: string;
    sessionId: string | null;
    absPath: string;
  }): Promise<SegmentFilePayload[]> {
    const relPath = path.relative(this.recordingRoot, params.absPath).replaceAll("\\", "/");
    const fileName = path.basename(params.absPath);

    // started_at của file MỚI parse từ tên. Đây là mốc chính xác lúc
    // ffmpeg mở file (strftime dùng clock local tại open time).
    // Fallback về now nếu tên file không match pattern (không nên xảy
    // ra vì watcher đã filter *.mp4, nhưng an toàn).
    const nextStartedAt = parseStartedAtFromFilename(fileName)
      ?? new Date().toISOString();

    const previous = this.currentByCamera.get(params.cameraId);
    if (previous && previous.absPath === params.absPath) {
      // Event trùng lặp cho cùng file → không phải rolled.
      return [];
    }

    const payloads: SegmentFilePayload[] = [];

    if (previous) {
      // Đóng segment cũ. ended_at = started_at của file kế tiếp
      // (mốc chính xác lúc ffmpeg mở file mới = lúc đóng file cũ).
      // duration = ended_at - previous.started_at, dựa vào mốc parse
      // từ tên file (chính xác đến giây), không dựa vào "watcher
      // observed" (có thể lệch chục giây).
      const startedMs = Date.parse(previous.startedAt);
      const endedMs = Date.parse(nextStartedAt);
      const duration = Math.max(0, Math.round((endedMs - startedMs) / 1000));
      const size = await this.safeStatSize(previous.absPath);
      payloads.push({
        camera_id: previous.cameraId,
        session_id: previous.sessionId,
        file_path: previous.filePath,
        file_name: previous.fileName,
        started_at: previous.startedAt,
        ended_at: nextStartedAt,
        duration_seconds: duration,
        file_size_bytes: size,
      });
    }

    const next: CurrentSegment = {
      cameraId: params.cameraId,
      sessionId: params.sessionId,
      filePath: relPath,
      fileName,
      absPath: params.absPath,
      startedAt: nextStartedAt,
    };
    this.currentByCamera.set(params.cameraId, next);

    payloads.push({
      camera_id: next.cameraId,
      session_id: next.sessionId,
      file_path: next.filePath,
      file_name: next.fileName,
      started_at: next.startedAt,
      ended_at: null,
      duration_seconds: null,
      file_size_bytes: null,
    });

    return payloads;
  }

  /**
   * Đóng segment đang mở của camera (khi ffmpeg exit — stop hoặc crash).
   * Trả về payload đóng, hoặc null nếu không có segment nào đang mở.
   */
  async closeCurrent(cameraId: string, endedAtMs?: number): Promise<SegmentFilePayload | null> {
    const current = this.currentByCamera.get(cameraId);
    if (!current) return null;
    this.currentByCamera.delete(cameraId);

    const endedAt = new Date(endedAtMs ?? Date.now()).toISOString();
    const startedMs = Date.parse(current.startedAt);
    const endedMs = Date.parse(endedAt);
    const duration = Math.max(0, Math.round((endedMs - startedMs) / 1000));
    const size = await this.safeStatSize(current.absPath);

    return {
      camera_id: current.cameraId,
      session_id: current.sessionId,
      file_path: current.filePath,
      file_name: current.fileName,
      started_at: current.startedAt,
      ended_at: endedAt,
      duration_seconds: duration,
      file_size_bytes: size,
    };
  }

  private async safeStatSize(absPath: string): Promise<number | null> {
    try {
      const st = await fs.stat(absPath);
      return st.size;
    } catch {
      return null;
    }
  }
}

const FILENAME_RE = /^[A-Za-z0-9_-]+_(\d{8})_(\d{6})\.mp4$/;

/**
 * Parse timestamp từ tên file segment (ffmpeg strftime local time)
 * và convert sang UTC. Đây là mốc CHÍNH XÁC lúc ffmpeg mở file, tốt
 * hơn "lúc watcher quan sát" nhiều lần khi watcher chậm.
 *
 * Node constructor `new Date(y, m-1, d, h, mi, s)` dùng TZ hệ thống,
 * `toISOString()` output UTC — không phụ thuộc hardcoded offset.
 * Máy set TZ VN → local args = giờ VN → toISOString ra UTC đúng.
 */
function parseStartedAtFromFilename(fileName: string): string | null {
  const m = FILENAME_RE.exec(fileName);
  if (!m) return null;
  const [, ymd, hms] = m;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const hour = Number(hms.slice(0, 2));
  const minute = Number(hms.slice(2, 4));
  const second = Number(hms.slice(4, 6));
  const d = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
