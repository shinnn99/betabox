import { promises as fs } from "node:fs";
import path from "node:path";
import { CLIPS_SUBDIR } from "./recording";

/**
 * Disk guard — tầng HÀNH ĐỘNG (cục bộ, không phụ thuộc cloud).
 *
 * Cảnh:
 *   `cleanup-segments.ps1` thi hành retention theo LỊCH (Chủ nhật hàng tuần).
 *   Đĩa thì đầy theo GIÂY. Bất kỳ nguyên nhân tăng đột biến nào — thêm camera,
 *   bitrate camera nhảy (Đại Kim đã nhảy 5,3× trong 12 ngày: 170 → 900
 *   MB/cam-giờ), Windows Update, phần mềm khác ăn ổ — đều có tối đa 7 ngày để
 *   ăn hết phần dư trước khi có ai dọn.
 *
 *   Đĩa đầy KHÔNG chỉ chặn ghi tương lai: ffmpeg bị cắt giữa chừng để lại mp4
 *   thiếu moov atom → không phát được, không concat được. Dạng hỏng này đã
 *   xảy ra thật trên máy Betacom (2026-07-13, nguyên nhân khác: shutdown
 *   không đợi flush). Nên phải hành động lúc còn ~12 giờ ghi, không phải lúc
 *   còn vài trăm MB.
 *
 * Nguyên tắc (chốt 2026-08-06):
 *   1. KHÔNG BAO GIỜ dừng ghi để giữ chỗ. Dừng ghi = mất bằng chứng vĩnh
 *      viễn; xoá đoạn cũ nhất = rút ngắn retention. Thiệt hại nhỏ hơn nhiều bậc.
 *   2. SÀN TUYỆT ĐỐI thắng mục tiêu. Không xoá segment trẻ hơn `floorDays`
 *      dù có đạt mục tiêu hay không. Chạm sàn mà vẫn thiếu chỗ → DỪNG + báo
 *      động, không xoá tiếp. Guard chạy loạn nguy hiểm hơn đĩa đầy: đĩa đầy
 *      mất bằng chứng từ giờ trở đi, guard chạy loạn mất bằng chứng ĐÃ CÓ.
 *   3. Đo lại dung lượng sau mỗi lô, KHÔNG tin lệnh xoá. Trên Windows, xoá
 *      file mà ffmpeg/antivirus còn giữ handle sẽ THẤT BẠI (không phải
 *      thành-công-rồi-giải-phóng-sau như Linux). "Đã gọi unlink 40 lần" và
 *      "đã đòi được chỗ" là hai chuyện khác nhau — và có báo động riêng.
 *   4. Ngưỡng tính bằng GIỜ GHI, không bằng phần trăm. 10% của ổ 4TB và 10%
 *      của ổ 500GB là hai mức nguy hiểm khác hẳn nhau. Tốc độ ăn đĩa suy từ
 *      chính segment kho đó vừa ghi → tự hiệu chỉnh khi thêm camera hoặc đổi
 *      bitrate, không ai phải sửa cấu hình.
 *
 * Phạm vi v1 — CHỈ XOÁ SEGMENT, KHÔNG ĐỤNG `_clips`:
 *   Clip có hai chế độ (chốt 2026-08-06): còn segment gốc trên đĩa = cache
 *   thuần (cắt lại được, xoá gần như miễn phí); hết segment gốc = BẢN DUY
 *   NHẤT còn tồn tại (bucket đã evict sau 72h — xem `src/lib/watch/cleanup.ts`).
 *
 *   Guard chạy cục bộ nên KHÔNG chứng minh được clip thuộc chế độ nào: file
 *   `_clips/<pe_id>.mp4` không mang thông tin nó cắt từ segment nào (mapping
 *   đó nằm ở `order_proof_clips.source_files` trên cloud). Suy theo tuổi file
 *   là đoán, và đoán sai ở đây = xoá mất bản cuối. Nên v1 chỉ ĐO và báo cáo
 *   dung lượng `_clips`, không xoá. Hiện toàn hệ có 48 clip nên phần này
 *   không đáng kể; khi nó lớn lên thì lời giải đúng là tầng clip đọc
 *   `source_files` + cờ bằng chứng, không phải heuristic tuổi file.
 */

// ============================================================================
// Kiểu dữ liệu
// ============================================================================

export interface VolumeUsage {
  freeBytes: number;
  totalBytes: number;
}

export type GuardLevel = "ok" | "warn" | "action";

export interface GuardStatus {
  level: GuardLevel;
  freeBytes: number;
  totalBytes: number;
  /** Byte mỗi GIỜ GHI (không phải giờ đồng hồ). null = chưa đo được. */
  bytesPerRecordingHour: number | null;
  /** Giờ ghi còn lại trước khi đầy. null khi chưa đo được tốc độ. */
  recordingHoursRemaining: number | null;
  /** Dung lượng `_clips` chiếm (chỉ báo cáo, v1 không xoá). */
  clipsBytes: number | null;
  measuredAtMs: number;
}

/** Kết quả chạy thử — đủ để trả lời "ngưỡng đặt đúng chưa" lúc onboarding. */
export interface DryRunReport {
  level: GuardLevel;
  freeBytes: number;
  totalBytes: number;
  bytesPerRecordingHour: number | null;
  /** Dung lượng trống quy ra GIỜ GHI — GB trống không nói được ngưỡng đúng/sai. */
  recordingHoursRemaining: number | null;
  clipsBytes: number | null;
  candidateCount: number;
  candidateBytes: number;
  /** Dải ngày sẽ bị đụng — để người xem đối chiếu với thứ không muốn mất. */
  oldestDayIso: string | null;
  newestDayIso: string | null;
  byCamera: Array<{ cameraCode: string; files: number; bytes: number }>;
  /** true = dọn hết ứng viên vẫn chưa đủ ⇒ ổ quá nhỏ so với retention. */
  wouldHitFloor: boolean;
  hoursAfterReclaim: number | null;
  walkMs: number;
  statMs: number;
  floorDays: number;
  /** true = tốc độ là ƯỚC LƯỢNG (có camera phải giả định segmentSeconds). */
  usedAssumedSegmentSeconds: boolean;
}

export interface SegmentCandidate {
  absPath: string;
  /** ms — suy từ thư mục YYYY/MM/DD, không phải mtime (rẻ hơn, đủ để xếp thứ tự). */
  dayMs: number;
  cameraCode: string;
}

export interface DiskGuardDeps {
  recordingRoot: string;
  /** Cam đang ghi — file mới nhất của cam này có thể đang mở, không đụng. */
  getActiveCameras: () => Array<{ cameraCode: string; segmentSeconds: number }>;
  /**
   * true khi đang cắt clip. Guard TẠM DỪNG toàn bộ việc xoá — job cắt có thể
   * đang đọc segment cũ bất kỳ, và ở hiện trạng (0 clip `ready` trên bucket,
   * mọi lần xem đều cắt lại) đây KHÔNG phải ca hiếm.
   */
  isCutInFlight: () => boolean;
}

export interface DiskGuardOptions {
  /** Chu kỳ kiểm (ms). Mặc định 5 phút — statfs rẻ, không duyệt cây. */
  checkIntervalMs?: number;
  /** Ngưỡng CẢNH BÁO, tính bằng giờ ghi còn lại. Mặc định 48. */
  warnHours?: number;
  /** Ngưỡng HÀNH ĐỘNG, tính bằng giờ ghi còn lại. Mặc định 12. */
  actionHours?: number;
  /**
   * Xoá cho tới khi đạt mốc này rồi mới dừng (hysteresis). Mặc định =
   * warnHours. Dừng ngay khi vừa qua vạch hành động sẽ kích hoạt lại sau
   * vài phút, liên tục.
   */
  stopHours?: number;
  /**
   * Trigger phụ khi CHƯA đo được tốc độ (kho nghỉ, agent vừa khởi động).
   * Mặc định 5 GiB.
   */
  absoluteFloorBytes?: number;
  /** SÀN TUYỆT ĐỐI: không xoá segment trẻ hơn ngần này ngày. Mặc định 7. */
  floorDays?: number;
  /** Số file mỗi lô trước khi đo lại dung lượng. Mặc định 20. */
  batchSize?: number;
  /** Trần số file xoá trong một tick (chống chạy loạn). Mặc định 2000. */
  maxDeletePerTick?: number;
  /** Timeout cho mỗi thao tác fs (ổ SMB/USB lag). Mặc định 5000ms. */
  fsTimeoutMs?: number;
  /**
   * segmentSeconds giả định khi phải suy camera từ ổ (chạy thử qua CLI, hoặc
   * kho tạm dừng ghi). Mặc định 60 — khớp RECORDING_SEGMENT_SECONDS mặc định.
   */
  assumedSegmentSeconds?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;

/**
 * Đệm múi giờ khi quy thư mục `YYYY/MM/DD` ra mốc thời gian.
 *
 * Thư mục ngày do `ensureTodayDir` tạo theo giờ ĐỊA PHƯƠNG của máy kho, còn
 * `parseDayDirMs` đọc ra mốc UTC. Ở VN (UTC+7) thư mục `2026-08-06` thật ra
 * bắt đầu lúc 2026-08-05T17:00Z. Không đệm thì guard coi một ngày là "đủ cũ"
 * sớm hơn thực tế tới gần một ngày. Đệm 14 giờ phủ mọi múi giờ (max UTC+14),
 * luôn lệch về phía AN TOÀN (giữ file lâu hơn sàn, không bao giờ ngắn hơn).
 */
const TZ_SLACK_MS = 14 * 60 * 60 * 1000;

/** Số segment gần nhất mỗi cam dùng để đo tốc độ (60s/segment → ~2 giờ ghi). */
const RATE_SAMPLE_FILES = 120;

/** Số thư mục lùi tối đa mỗi tầng khi tìm thư mục ngày còn segment. */
const MAX_SAMPLE_DIR_PROBES = 5;

/**
 * Nhắc lại giãn dần cho các trạng thái KÉO DÀI (chạm sàn, không đòi được chỗ).
 *
 * Chạm sàn không phải sự kiện tức thời — nó giữ nguyên cho tới khi có người
 * can thiệp. Với chu kỳ 5', log mỗi tick = 288 dòng/ngày/agent đẩy thẳng lên
 * `agent_log_events` (bảng hiện chỉ có ~2.3k dòng tổng). Một agent kẹt sàn
 * qua cuối tuần sẽ nhấn chìm mọi lỗi khác đúng lúc cần đọc log nhất.
 *
 * Nên: log ở CHUYỂN TRẠNG THÁI, rồi nhắc lại theo thang 30' → 2h → 6h → giữ 6h.
 */
const REPEAT_LADDER_MS = [30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

/** Nhịp gửi số liệu định kỳ LÊN CLOUD (console.warn). 1 dòng/ngày/agent. */
const DAILY_REPORT_MS = 24 * 60 * 60_000;

/** Ngưỡng đổi tốc độ đủ lớn để báo ngay, không đợi tới nhịp ngày. */
const RATE_CHANGE_REPORT_FACTOR = 1.5;

/**
 * Bộ nhắc lại giãn dần. Lần đầu vào trạng thái → báo ngay; đang trong trạng
 * thái → chỉ báo lại khi qua mốc thang; thoát trạng thái → `clear` trả true
 * để caller ghi một dòng "đã thoát".
 */
export class RepeatNotifier {
  private state = new Map<string, { lastMs: number; step: number }>();

  constructor(private readonly ladderMs: number[] = REPEAT_LADDER_MS) {}

  shouldNotify(key: string, nowMs: number): boolean {
    const cur = this.state.get(key);
    if (!cur) {
      this.state.set(key, { lastMs: nowMs, step: 0 });
      return true;
    }
    const delay = this.ladderMs[Math.min(cur.step, this.ladderMs.length - 1)];
    if (nowMs - cur.lastMs >= delay) {
      this.state.set(key, { lastMs: nowMs, step: cur.step + 1 });
      return true;
    }
    return false;
  }

  /** true nếu key đang active (vừa được xoá) — dùng để log dòng "đã thoát". */
  clear(key: string): boolean {
    return this.state.delete(key);
  }

  isActive(key: string): boolean {
    return this.state.has(key);
  }
}

// ============================================================================
// Hàm thuần — export riêng để test không cần dựng ổ đĩa
// ============================================================================

/**
 * Tốc độ ăn đĩa tính theo GIỜ GHI, không theo giờ đồng hồ.
 *
 * Vì sao: Đại Kim ghi ~9 cam-giờ trong 24 giờ đồng hồ (kho đóng cửa phần lớn
 * thời gian, nghỉ Chủ nhật). Chia theo giờ đồng hồ ra 0,33 GB/giờ → ngưỡng 12
 * giờ chỉ còn ~4 GB, quá mỏng, và nó GIẢ ĐỊNH kho tiếp tục nghỉ đúng nhịp cũ.
 * Tính theo giờ ghi ra 1,8 GB/giờ → ngưỡng 12 giờ ~22 GB: đây là trường hợp
 * xấu nhất thực tế (mọi camera ghi liên tục), không sụp khi kho làm thêm ca.
 *
 * Mỗi segment đã đóng phủ ~segmentSeconds giây ghi, nên:
 *   giờ_ghi = số_file × segmentSeconds / 3600
 */
export function computeBytesPerRecordingHour(
  files: Array<{ sizeBytes: number }>,
  segmentSeconds: number,
): number | null {
  if (files.length === 0 || segmentSeconds <= 0) return null;
  const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  if (totalBytes <= 0) return null;
  const recordingHours = (files.length * segmentSeconds) / 3600;
  if (recordingHours <= 0) return null;
  return totalBytes / recordingHours;
}

export function computeRecordingHoursRemaining(
  freeBytes: number,
  bytesPerRecordingHour: number | null,
): number | null {
  if (bytesPerRecordingHour === null || bytesPerRecordingHour <= 0) return null;
  return freeBytes / bytesPerRecordingHour;
}

export function classifyLevel(
  freeBytes: number,
  recordingHoursRemaining: number | null,
  opts: { warnHours: number; actionHours: number; absoluteFloorBytes: number },
): GuardLevel {
  // Trigger phụ: dưới sàn tuyệt đối thì hành động BẤT KỂ đo được tốc độ hay
  // không. Đây là lưới cho ca kho nghỉ dài (rate=null) mà phần mềm khác ăn ổ.
  if (freeBytes < opts.absoluteFloorBytes) return "action";
  if (recordingHoursRemaining === null) return "ok";
  if (recordingHoursRemaining < opts.actionHours) return "action";
  if (recordingHoursRemaining < opts.warnHours) return "warn";
  return "ok";
}

/** Parse `<root>/<cam>/YYYY/MM/DD` → ms đầu ngày UTC. null nếu không khớp. */
export function parseDayDirMs(y: string, m: string, d: string): number | null {
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;
  const ms = Date.parse(`${y}-${m}-${d}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Xếp ứng viên xoá: cũ nhất trước, và LOẠI mọi thứ trẻ hơn sàn.
 *
 * Sàn dùng ngày-cuối-của-thư-mục (dayMs + 1 ngày) để so, không dùng đầu ngày:
 * file ghi lúc 23:59 ngày D vẫn thuộc thư mục D. So bằng đầu ngày sẽ xoá sớm
 * hơn sàn tới gần 24 giờ.
 */
export function orderSegmentCandidates(
  candidates: SegmentCandidate[],
  opts: { nowMs: number; floorDays: number },
): SegmentCandidate[] {
  const floorCutoffMs = opts.nowMs - opts.floorDays * DAY_MS;
  return candidates
    .filter((c) => c.dayMs + DAY_MS + TZ_SLACK_MS <= floorCutoffMs)
    .sort((a, b) => a.dayMs - b.dayMs || a.absPath.localeCompare(b.absPath));
}

// ============================================================================
// I/O helpers
// ============================================================================

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readVolumeUsage(
  targetPath: string,
  timeoutMs = 5000,
): Promise<VolumeUsage> {
  const st = await withTimeout(fs.statfs(targetPath), timeoutMs, "statfs");
  return {
    freeBytes: st.bavail * st.bsize,
    totalBytes: st.blocks * st.bsize,
  };
}

function fmtGb(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Mốc bắt đầu suy từ tên `<code>_<YYYYMMDD>_<HHMMSS>.mp4`. null nếu không khớp. */
export function parseSegmentStartMs(name: string): number | null {
  const m = /_(\d{8})_(\d{6})\.mp4$/i.exec(name);
  if (!m) return null;
  const [, d, t] = m;
  const ms = Date.UTC(
    Number(d.slice(0, 4)),
    Number(d.slice(4, 6)) - 1,
    Number(d.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
  );
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Suy `segmentSeconds` THẬT từ khoảng cách giữa các segment liên tiếp.
 *
 * Tốt hơn hằng số giả định: mỗi kho có thể cấu hình khác nhau, và đoán sai
 * làm lệch TUYẾN TÍNH con số tốc độ ăn đĩa (segment thật 120s mà giả định 60
 * thì tốc độ báo gấp đôi).
 *
 * Dùng TRUNG VỊ chứ không phải trung bình: cam ngừng ghi giữa ngày rồi ghi
 * lại sẽ tạo một khoảng cách khổng lồ, trung bình bị kéo lệch còn trung vị
 * thì không.
 *
 * Trả null nếu quá ít mẫu hoặc kết quả nằm ngoài khoảng hợp lý — caller quay
 * về hằng số giả định.
 */
export function inferSegmentSecondsFromNames(
  names: string[],
  opts: { minSeconds?: number; maxSeconds?: number } = {},
): number | null {
  const minSeconds = opts.minSeconds ?? 5;
  const maxSeconds = opts.maxSeconds ?? 600;
  const starts = names
    .map(parseSegmentStartMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (starts.length < 3) return null;

  const deltas: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const d = (starts[i] - starts[i - 1]) / 1000;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  if (median < minSeconds || median > maxSeconds) return null;
  return median;
}

// ============================================================================
// DiskGuard
// ============================================================================

export class DiskGuard {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastLevel: GuardLevel = "ok";
  private lastStatus: GuardStatus | null = null;
  private lastTickCompletedMs = Date.now();
  private readonly notifier = new RepeatNotifier();
  private lastDailyReportMs = 0;
  private lastReportedRate: number | null = null;

  private readonly checkIntervalMs: number;
  private readonly warnHours: number;
  private readonly actionHours: number;
  private readonly stopHours: number;
  private readonly absoluteFloorBytes: number;
  private readonly floorDays: number;
  private readonly batchSize: number;
  private readonly maxDeletePerTick: number;
  private readonly fsTimeoutMs: number;
  private readonly assumedSegmentSeconds: number;
  /**
   * true khi có camera phải dùng segmentSeconds GIẢ ĐỊNH (không suy được từ
   * tên file). Chỉ để in ra — người đọc phải biết đâu là số đo, đâu là đoán.
   */
  private usedAssumedSegmentSeconds = false;

  constructor(
    private readonly deps: DiskGuardDeps,
    opts: DiskGuardOptions = {},
  ) {
    this.checkIntervalMs = opts.checkIntervalMs ?? 5 * 60_000;
    this.warnHours = opts.warnHours ?? 48;
    this.actionHours = opts.actionHours ?? 12;
    this.stopHours = opts.stopHours ?? this.warnHours;
    this.absoluteFloorBytes = opts.absoluteFloorBytes ?? 5 * GIB;
    this.floorDays = opts.floorDays ?? 7;
    this.batchSize = opts.batchSize ?? 20;
    this.maxDeletePerTick = opts.maxDeletePerTick ?? 2000;
    this.fsTimeoutMs = opts.fsTimeoutMs ?? 5000;
    this.assumedSegmentSeconds = opts.assumedSegmentSeconds ?? 60;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error(`[disk-guard] tick error: ${(err as Error).message}`);
      });
    }, this.checkIntervalMs);
    console.log(
      `[disk-guard] installed (mỗi ${Math.round(this.checkIntervalMs / 1000)}s, ` +
        `cảnh báo <${this.warnHours}h ghi, hành động <${this.actionHours}h ghi, ` +
        `sàn ${this.floorDays} ngày)`,
    );
    // Chạy ngay một nhịp: nếu ổ đã sát ngưỡng lúc agent khởi động thì không
    // nên đợi hết chu kỳ đầu.
    void this.tick().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** ms kể từ tick cuối chạy xong — cho heartbeat sau này (đợt 31/8). */
  getLivenessMsAgo(): number {
    return Date.now() - this.lastTickCompletedMs;
  }

  /** Trạng thái đo được gần nhất — cho heartbeat sau này (đợt 31/8). */
  getStatus(): GuardStatus | null {
    return this.lastStatus;
  }

  /**
   * Chạy thử: đi HẾT đường chọn ứng viên rồi dừng trước `unlink`.
   *
   * Vì sao là một PHƯƠNG THỨC RIÊNG chứ không phải cờ khởi động: cờ có thể
   * bị bật ở kho khách rồi quên, và guard sẽ nằm im vĩnh viễn trong khi nhìn
   * vẫn như đang chạy — đúng dạng lỗi im lặng mà cả lớp này sinh ra để tránh.
   * Ở đây không có đường nào từ dryRun() rơi vào nhánh xoá: nó không gọi
   * `reclaim`, và `tick()` không biết dryRun tồn tại.
   *
   * Dùng cho:
   *   - Onboarding kho mới: mỗi kho có ổ khác, số camera khác, tốc độ ăn đĩa
   *     khác. "Ngưỡng đặt đúng chưa" hiện chỉ có hai cách biết — chờ đủ lâu,
   *     hoặc để nó xoá thật. Đây là cách thứ ba, chạy được ngay ngày lắp máy.
   *   - Đo thời gian duyệt cây thật mà không mất một byte nào.
   */
  async dryRun(): Promise<DryRunReport> {
    const status = await this.measure();

    const walkStart = Date.now();
    const raw = await this.listSegmentCandidates();
    const walkMs = Date.now() - walkStart;

    const ordered = orderSegmentCandidates(raw, {
      nowMs: Date.now(),
      floorDays: this.floorDays,
    });

    const statStart = Date.now();
    const byCamera = new Map<string, { files: number; bytes: number }>();
    let candidateBytes = 0;
    for (const c of ordered) {
      let size = 0;
      try {
        const st = await withTimeout(fs.stat(c.absPath), this.fsTimeoutMs, "stat");
        size = st.size;
      } catch {
        /* file vừa biến mất — bỏ qua, vẫn đếm vào số file */
      }
      candidateBytes += size;
      const cur = byCamera.get(c.cameraCode) ?? { files: 0, bytes: 0 };
      cur.files++;
      cur.bytes += size;
      byCamera.set(c.cameraCode, cur);
    }
    const statMs = Date.now() - statStart;

    const targetBytes =
      status.bytesPerRecordingHour === null
        ? this.absoluteFloorBytes * 2
        : this.stopHours * status.bytesPerRecordingHour;
    const freeAfter = status.freeBytes + candidateBytes;

    const report: DryRunReport = {
      level: status.level,
      freeBytes: status.freeBytes,
      totalBytes: status.totalBytes,
      bytesPerRecordingHour: status.bytesPerRecordingHour,
      recordingHoursRemaining: status.recordingHoursRemaining,
      clipsBytes: status.clipsBytes,
      candidateCount: ordered.length,
      candidateBytes,
      oldestDayIso: ordered.length > 0 ? isoDay(ordered[0].dayMs) : null,
      newestDayIso: ordered.length > 0 ? isoDay(ordered[ordered.length - 1].dayMs) : null,
      byCamera: [...byCamera.entries()].map(([cameraCode, v]) => ({ cameraCode, ...v })),
      // Chạm sàn ngay lần đầu = ổ quá nhỏ so với retention. Đây là vấn đề
      // PHẦN CỨNG, không sửa được bằng cách chỉnh ngưỡng.
      wouldHitFloor: freeAfter < targetBytes,
      hoursAfterReclaim: computeRecordingHoursRemaining(
        freeAfter,
        status.bytesPerRecordingHour,
      ),
      walkMs,
      statMs,
      floorDays: this.floorDays,
      usedAssumedSegmentSeconds: this.usedAssumedSegmentSeconds,
    };

    this.logDryRun(report);
    return report;
  }

  private logDryRun(r: DryRunReport): void {
    const hours = (h: number | null) => (h === null ? "?(chưa đo được)" : `${h.toFixed(1)}h-ghi`);
    console.log("=== disk-guard CHẠY THỬ (không xoá gì) ===");
    console.log(
      `  ổ: trống ${fmtGb(r.freeBytes)}GB / ${fmtGb(r.totalBytes)}GB → còn ${hours(r.recordingHoursRemaining)}` +
        ` (mức hiện tại: ${r.level})`,
    );
    console.log(
      `  tốc độ ăn đĩa: ${r.bytesPerRecordingHour === null ? "chưa đo được (không có segment nào để lấy mẫu)" : (r.bytesPerRecordingHour / 1024 ** 2).toFixed(0) + " MB mỗi giờ ghi"}` +
        (r.usedAssumedSegmentSeconds
          ? ` — CẢNH BÁO: có camera phải dùng segmentSeconds GIẢ ĐỊNH ${this.assumedSegmentSeconds}s (không suy được từ tên file), con số này là ƯỚC LƯỢNG chứ không phải số đo`
          : " (segmentSeconds suy từ khoảng cách tên file, không giả định)"),
    );
    console.log(
      `  ứng viên xoá: ${r.candidateCount} file, ${fmtGb(r.candidateBytes)}GB` +
        (r.oldestDayIso ? `, dải ngày ${r.oldestDayIso} → ${r.newestDayIso}` : ""),
    );
    for (const c of r.byCamera) {
      console.log(`    ${c.cameraCode}: ${c.files} file, ${fmtGb(c.bytes)}GB`);
    }
    console.log(`  sau khi dọn hết: còn ${hours(r.hoursAfterReclaim)}`);
    console.log(
      `  chạm sàn ${r.floorDays} ngày: ${r.wouldHitFloor ? "CÓ — ổ quá nhỏ so với retention, phải xử lý bằng phần cứng chứ không bằng ngưỡng" : "không"}`,
    );
    console.log(`  duyệt cây ${r.walkMs}ms, stat ứng viên ${r.statMs}ms`);
    // Một dòng lên cloud: chạy thử là thao tác tay, không có nguy cơ ngập.
    console.warn(
      `[disk-guard] chạy thử: trống ${fmtGb(r.freeBytes)}GB (${hours(r.recordingHoursRemaining)}), ` +
        `ứng viên ${r.candidateCount} file/${fmtGb(r.candidateBytes)}GB` +
        (r.oldestDayIso ? ` dải ${r.oldestDayIso}→${r.newestDayIso}` : "") +
        `, chạm sàn=${r.wouldHitFloor ? "CÓ" : "không"}, duyệt cây ${r.walkMs}ms`,
    );
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const status = await this.measure();
      this.lastStatus = status;
      this.logLevelTransition(status);

      if (status.level !== "action") return;

      if (this.deps.isCutInFlight()) {
        console.warn(
          "[disk-guard] cần dọn nhưng đang cắt clip — hoãn tới nhịp sau " +
            "(job cắt có thể đang đọc segment cũ bất kỳ)",
        );
        return;
      }

      await this.reclaim(status);
    } finally {
      this.ticking = false;
      this.lastTickCompletedMs = Date.now();
    }
  }

  // --------------------------------------------------------------------
  // Đo
  // --------------------------------------------------------------------

  private async measure(): Promise<GuardStatus> {
    const usage = await readVolumeUsage(this.deps.recordingRoot, this.fsTimeoutMs);
    const rate = await this.measureRate();
    const hours = computeRecordingHoursRemaining(usage.freeBytes, rate);
    const clipsBytes = await this.measureClipsBytes();
    return {
      level: classifyLevel(usage.freeBytes, hours, {
        warnHours: this.warnHours,
        actionHours: this.actionHours,
        absoluteFloorBytes: this.absoluteFloorBytes,
      }),
      freeBytes: usage.freeBytes,
      totalBytes: usage.totalBytes,
      bytesPerRecordingHour: rate,
      recordingHoursRemaining: hours,
      clipsBytes,
      measuredAtMs: Date.now(),
    };
  }

  /**
   * Tốc độ suy từ segment các cam ĐANG GHI vừa ghi hôm nay. Không duyệt cả
   * cây — chỉ thư mục ngày hôm nay của từng cam đang ghi (~250 file/cam).
   *
   * Bỏ file đang mở (size 0 hoặc mtime quá mới): kích thước chưa chốt sẽ kéo
   * trung bình xuống.
   */
  private async measureRate(): Promise<number | null> {
    let cams: Array<{ cameraCode: string; segmentSeconds: number; sampleDir?: string }> =
      this.deps.getActiveCameras();
    if (cams.length === 0) {
      // Không cam nào đang ghi TRONG TIẾN TRÌNH NÀY. Hai ca:
      //   - chạy thử qua CLI (`--disk-guard-dry-run`): service đang ghi ở
      //     tiến trình khác, tiến trình này không thấy gì;
      //   - kho tạm dừng ghi.
      // Cả hai đều KHÔNG có nghĩa là "đĩa không bao giờ đầy nữa". Suy tốc độ
      // từ chính segment trên ổ: lấy thư mục ngày MỚI NHẤT của mỗi camera.
      // Ước lượng (segmentSeconds giả định), nên chỉ dùng khi không có nguồn
      // chính xác hơn — nhưng có ước lượng vẫn hơn không có số nào, vì không
      // có số thì `recordingHoursRemaining` = null và mọi ngưỡng theo giờ
      // đều tắt.
      cams = await this.inferCamerasFromDisk();
      if (cams.length === 0) return null;
    }

    const collected: Array<{ sizeBytes: number }> = [];
    let segmentSecondsSum = 0;
    let segmentSecondsCount = 0;

    for (const cam of cams) {
      const dir = cam.sampleDir ?? this.todayDirFor(cam.cameraCode);
      const openCutoffMs = Date.now() - cam.segmentSeconds * 2000;
      let names: string[];
      try {
        names = await withTimeout(fs.readdir(dir), this.fsTimeoutMs, "readdir today");
      } catch {
        continue;
      }
      // Chỉ lấy mẫu các segment GẦN NHẤT, không stat cả ngày (cuối ngày ~500
      // file/cam). Tên file có dạng `<code>_<YYYYMMDD>_<HHMMSS>.mp4` nên sắp
      // xếp chuỗi = sắp xếp thời gian. Mẫu gần bám sát bitrate hiện tại —
      // quan trọng vì bitrate camera có thể đổi giữa chừng (Đại Kim 170 →
      // 900 MB/cam-giờ trong 12 ngày).
      const collectedBefore = collected.length;
      const sample = names
        .filter((n) => n.toLowerCase().endsWith(".mp4"))
        .sort()
        .slice(-RATE_SAMPLE_FILES);
      for (const name of sample) {
        try {
          const st = await withTimeout(
            fs.stat(path.join(dir, name)),
            this.fsTimeoutMs,
            "stat",
          );
          if (st.size <= 0) continue;
          if (st.mtimeMs > openCutoffMs) continue; // có thể đang mở
          collected.push({ sizeBytes: st.size });
        } catch {
          /* file vừa bị xoá/khoá — bỏ qua */
        }
      }
      // CHỈ tính segmentSeconds của camera THỰC SỰ đóng góp mẫu. Camera có
      // thư mục rỗng (vừa spawn chưa xoay segment nào, hoặc vừa dừng ghi)
      // không có byte nào trong `collected` nhưng vẫn kéo trung bình
      // segmentSeconds → tốc độ tính ra sai mà không dấu vết.
      if (collected.length > collectedBefore) {
        segmentSecondsSum += cam.segmentSeconds;
        segmentSecondsCount++;
      }
    }

    if (segmentSecondsCount === 0) return null;
    const avgSegmentSeconds = segmentSecondsSum / segmentSecondsCount;
    return computeBytesPerRecordingHour(collected, avgSegmentSeconds);
  }

  /** Dung lượng `_clips` — chỉ để báo cáo. v1 KHÔNG xoá clip (xem đầu file). */
  private async measureClipsBytes(): Promise<number | null> {
    const dir = path.join(this.deps.recordingRoot, CLIPS_SUBDIR);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await withTimeout(
        fs.readdir(dir, { withFileTypes: true }),
        this.fsTimeoutMs,
        "readdir clips",
      );
    } catch {
      return null;
    }
    let total = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const st = await withTimeout(
          fs.stat(path.join(dir, e.name)),
          this.fsTimeoutMs,
          "stat clip",
        );
        total += st.size;
      } catch {
        /* bỏ qua */
      }
    }
    return total;
  }

  /**
   * Suy danh sách camera + thư mục mẫu từ CHÍNH CẤU TRÚC THƯ MỤC trên ổ.
   *
   * Dùng cùng quy ước khuôn ngày `YYYY/MM/DD` với `listSegmentCandidates` và
   * với `cleanup-segments.ps1` — một quy ước, ba chỗ đọc. Nhờ vậy thư mục lạ
   * (`logs/`…) không bị nhận nhầm là camera ở đây nữa.
   *
   * `segmentSeconds` giả định (mặc định 60) vì tiến trình này không có
   * credentials. Sai số tuyến tính: segment thật 120s thì tốc độ ước lượng
   * gấp đôi thực tế → guard bi quan, không lạc quan. Lệch về phía an toàn.
   */
  private async inferCamerasFromDisk(): Promise<
    Array<{ cameraCode: string; segmentSeconds: number; sampleDir: string }>
  > {
    const out: Array<{ cameraCode: string; segmentSeconds: number; sampleDir: string }> = [];
    for (const cam of await this.safeReaddirNames(this.deps.recordingRoot)) {
      if (cam === CLIPS_SUBDIR) continue;
      const camDir = path.join(this.deps.recordingRoot, cam);
      const years = (await this.safeReaddirNames(camDir)).filter((y) => /^\d{4}$/.test(y)).sort();
      if (years.length === 0) continue; // không phải thư mục camera
      // Thư mục ngày mới nhất có thể RỖNG (di tích sau khi dọn, hoặc camera
      // đã gỡ). Lùi dần tới thư mục ngày gần nhất THỰC SỰ CÓ segment — thư
      // mục rỗng không cho mẫu nào, mà lại làm hỏng phép suy segmentSeconds.
      // Verify 2026-08-06 trên máy dev: cam_02 và CAM_HONG_TEST đều có thư
      // mục ngày mới nhất rỗng.
      let sampleDir: string | null = null;
      let names: string[] = [];
      outer: for (const y of [...years].reverse().slice(0, MAX_SAMPLE_DIR_PROBES)) {
        const months = (await this.safeReaddirNames(path.join(camDir, y)))
          .filter((mm) => /^\d{2}$/.test(mm))
          .sort()
          .reverse();
        for (const mm of months.slice(0, MAX_SAMPLE_DIR_PROBES)) {
          const days = (await this.safeReaddirNames(path.join(camDir, y, mm)))
            .filter((dd) => /^\d{2}$/.test(dd))
            .sort()
            .reverse();
          for (const dd of days.slice(0, MAX_SAMPLE_DIR_PROBES)) {
            const dir = path.join(camDir, y, mm, dd);
            const found = (await this.safeReaddirNames(dir)).filter((n) =>
              n.toLowerCase().endsWith(".mp4"),
            );
            if (found.length > 0) {
              sampleDir = dir;
              names = found;
              break outer;
            }
          }
        }
      }
      if (sampleDir === null) continue; // camera không còn segment nào

      // Suy segmentSeconds THẬT từ khoảng cách tên file, không giả định:
      // đoán sai làm lệch TUYẾN TÍNH con số tốc độ ăn đĩa.
      const measured = inferSegmentSecondsFromNames(names);
      if (measured === null) this.usedAssumedSegmentSeconds = true;
      out.push({
        cameraCode: cam,
        segmentSeconds: measured ?? this.assumedSegmentSeconds,
        sampleDir,
      });
    }
    return out;
  }

  private todayDirFor(cameraCode: string): string {
    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return path.join(this.deps.recordingRoot, cameraCode, y, m, d);
  }

  private logLevelTransition(s: GuardStatus): void {
    const hours =
      s.recordingHoursRemaining === null
        ? "?(chưa đo được)"
        : `${s.recordingHoursRemaining.toFixed(1)}h-ghi`;
    const rate =
      s.bytesPerRecordingHour === null
        ? "?"
        : `${(s.bytesPerRecordingHour / 1024 ** 2).toFixed(0)}MB/h-ghi`;
    const line =
      `free=${fmtGb(s.freeBytes)}GB/${fmtGb(s.totalBytes)}GB còn=${hours} ` +
      `tốc độ=${rate} clips=${s.clipsBytes === null ? "?" : fmtGb(s.clipsBytes) + "GB"}`;

    // Dòng info mỗi nhịp: CHỈ ra log local (console.log không được
    // remote-logger đẩy lên cloud), nên không có nguy cơ ngập bảng.
    console.log(`[disk-guard] ${s.level} — ${line}`);

    if (s.level !== this.lastLevel) {
      if (s.level === "ok") {
        console.warn(`[disk-guard] về mức bình thường — ${line}`);
        // Thoát khỏi các trạng thái kéo dài → đóng sổ, để lần sau vào lại
        // được báo ngay từ đầu thang.
        if (this.notifier.clear("floor_reached")) {
          console.warn("[disk-guard] đã thoát trạng thái chạm sàn");
        }
        if (this.notifier.clear("reclaim_failed")) {
          console.warn("[disk-guard] đã thoát trạng thái không đòi được chỗ");
        }
      } else if (s.level === "warn") {
        console.warn(`[disk-guard] CẢNH BÁO dung lượng — ${line}`);
      } else {
        // Guard kích hoạt trên kho đang chạy ổn định KHÔNG phải vận hành
        // bình thường: nếu `cleanup-segments.ps1` chạy đúng thì đĩa đạt
        // trạng thái ổn định và không bao giờ chạm ngưỡng này. Đến được đây
        // nghĩa là dọn hàng tuần đã hỏng từ trước, hoặc có thứ ngoài Betabox
        // ăn ổ. Câu chữ phải nói đúng điều đó, không phải "đã xử lý xong".
        console.warn(
          `[disk-guard] NGƯỠNG HÀNH ĐỘNG — ${line}. ` +
            `Đây là SỰ CỐ, không phải vận hành thường: dọn theo lịch lẽ ra đã ` +
            `giữ đĩa ở trạng thái ổn định. Kiểm cleanup-segments.ps1 (Task ` +
            `Scheduler), số camera, và phần mềm khác đang ăn ổ.`,
        );
      }
      this.lastLevel = s.level;
    }

    this.maybeReportMetrics(s, line);
  }

  /**
   * Số liệu lên cloud: 1 dòng/ngày, cộng một dòng khi tốc độ ăn đĩa đổi đáng
   * kể. Đây là thứ dùng để chọn ổ cho kho tiếp theo — Đại Kim đã nhảy 5,3×
   * trong 12 ngày nên "đo một lần rồi chốt" là không đủ.
   *
   * Dùng console.warn vì chỉ warn/error mới được remote-logger đẩy lên
   * `agent_log_events`. 1 dòng/ngày/agent là chi phí chấp nhận được.
   */
  private maybeReportMetrics(s: GuardStatus, line: string): void {
    const now = Date.now();
    const rate = s.bytesPerRecordingHour;
    const changed =
      rate !== null &&
      this.lastReportedRate !== null &&
      (rate > this.lastReportedRate * RATE_CHANGE_REPORT_FACTOR ||
        rate * RATE_CHANGE_REPORT_FACTOR < this.lastReportedRate);

    if (now - this.lastDailyReportMs < DAILY_REPORT_MS && !changed) return;

    console.warn(
      `[disk-guard] số liệu${changed ? " (tốc độ ăn đĩa đổi đáng kể)" : ""} — ${line}`,
    );
    this.lastDailyReportMs = now;
    if (rate !== null) this.lastReportedRate = rate;
  }

  // --------------------------------------------------------------------
  // Dọn
  // --------------------------------------------------------------------

  private async reclaim(start: GuardStatus): Promise<void> {
    const candidates = orderSegmentCandidates(await this.listSegmentCandidates(), {
      nowMs: Date.now(),
      floorDays: this.floorDays,
    });

    if (candidates.length === 0) {
      // Trạng thái kéo dài → nhắc lại giãn dần, không log mỗi 5 phút.
      if (this.notifier.shouldNotify("floor_reached", Date.now())) {
        console.error(
          `[disk-guard] CHẠM SÀN: cần dọn nhưng không còn segment nào cũ hơn ` +
            `${this.floorDays} ngày. DỪNG xoá. free=${fmtGb(start.freeBytes)}GB. ` +
            `Cần can thiệp tay: thêm ổ, giảm số camera, hoặc giảm retention. ` +
            `(báo lại giãn dần 30' → 2h → 6h cho tới khi hết)`,
        );
      }
      return;
    }

    const targetBytes =
      start.bytesPerRecordingHour === null
        ? this.absoluteFloorBytes * 2
        : this.stopHours * start.bytesPerRecordingHour;

    console.warn(
      `[disk-guard] BẮT ĐẦU DỌN: free=${fmtGb(start.freeBytes)}GB ` +
        `mục tiêu=${fmtGb(targetBytes)}GB ứng viên=${candidates.length} file ` +
        `(cũ nhất ${new Date(candidates[0].dayMs).toISOString().slice(0, 10)})`,
    );

    let deletedTotal = 0;
    let lockedTotal = 0;
    let firstLockError: string | null = null;
    let freedTotal = 0;
    let oldestDeletedMs: number | null = null;
    let newestDeletedMs: number | null = null;
    let prevFree = start.freeBytes;
    let exhausted = true;

    for (let i = 0; i < candidates.length; i += this.batchSize) {
      if (deletedTotal >= this.maxDeletePerTick) {
        console.warn(
          `[disk-guard] chạm trần ${this.maxDeletePerTick} file/tick — dừng lô, ` +
            `tiếp tục ở nhịp sau`,
        );
        exhausted = false;
        break;
      }

      const batch = candidates.slice(i, i + this.batchSize);
      let deletedInBatch = 0;
      for (const c of batch) {
        try {
          await withTimeout(fs.unlink(c.absPath), this.fsTimeoutMs, "unlink");
          deletedInBatch++;
          deletedTotal++;
          oldestDeletedMs = oldestDeletedMs === null ? c.dayMs : Math.min(oldestDeletedMs, c.dayMs);
          newestDeletedMs = newestDeletedMs === null ? c.dayMs : Math.max(newestDeletedMs, c.dayMs);
        } catch (err) {
          // EBUSY/EPERM trên Windows = file còn handle (ffmpeg đang ghi,
          // antivirus đang quét). KHÔNG phải lỗi guard, nhưng nếu CẢ LÔ đều
          // khoá thì đó là tín hiệu khác — bắt ở kiểm tra freed bên dưới.
          //
          // Giữ lý do ĐẦU TIÊN để log một lần ở tổng kết: "khoá N file" mà
          // không nói vì sao thì ở kho khách không chẩn được. Chỉ một dòng,
          // không phải mỗi file (một lô khoá cả 20 thì 20 dòng là ngập).
          lockedTotal++;
          // Message của Node đã mở đầu bằng chính mã lỗi ("EBUSY: resource
          // busy or locked, unlink '...'") nên không ghép thêm code vào nữa.
          if (firstLockError === null) firstLockError = (err as Error).message;
        }
      }

      const after = await readVolumeUsage(this.deps.recordingRoot, this.fsTimeoutMs);
      const freed = after.freeBytes - prevFree;
      prevFree = after.freeBytes;
      if (freed > 0) freedTotal += freed;

      // Nguyên tắc 3: xoá được file ≠ đòi được chỗ.
      // Nhiễu từ ghi song song rất nhỏ so với một lô (ghi ~1,8GB/giờ = ~2,5MB
      // trong vài giây; một lô 20 file ≈ 400MB), nên `freed <= 0` là tín hiệu
      // thật, không phải nhiễu.
      if (deletedInBatch > 0 && freed <= 0) {
        if (this.notifier.shouldNotify("reclaim_failed", Date.now())) {
          console.error(
            `[disk-guard] KHÔNG ĐÒI ĐƯỢC CHỖ: xoá ${deletedInBatch} file nhưng ` +
              `dung lượng trống không tăng (free=${fmtGb(after.freeBytes)}GB). ` +
              `Nguyên nhân thường gặp: file còn handle mở, Volume Shadow Copy giữ ` +
              `bản sao, hoặc ổ báo sai. DỪNG dọn — đây KHÔNG phải "đĩa sắp đầy".`,
          );
        }
        exhausted = false;
        break;
      }

      if (after.freeBytes >= targetBytes) {
        exhausted = false;
        break; // hysteresis: dừng ở stopHours, không dừng ngay khi qua vạch
      }
    }

    const daysSpan =
      oldestDeletedMs !== null && newestDeletedMs !== null
        ? Math.round((newestDeletedMs - oldestDeletedMs) / DAY_MS) + 1
        : 0;

    console.warn(
      `[disk-guard] DỌN XONG: xoá ${deletedTotal} file ` +
        `(${fmtGb(freedTotal)}GB, ${daysSpan} ngày dữ liệu` +
        `${oldestDeletedMs !== null ? `, từ ${new Date(oldestDeletedMs).toISOString().slice(0, 10)}` : ""}` +
        `), khoá ${lockedTotal} file, free=${fmtGb(prevFree)}GB` +
        (firstLockError !== null ? ` — lý do đầu tiên: ${firstLockError}` : ""),
    );

    if (
      exhausted &&
      prevFree < targetBytes &&
      this.notifier.shouldNotify("floor_reached", Date.now())
    ) {
      console.error(
        `[disk-guard] CHẠM SÀN sau khi dọn: đã xoá hết segment cũ hơn ` +
          `${this.floorDays} ngày mà free=${fmtGb(prevFree)}GB vẫn dưới mục tiêu ` +
          `${fmtGb(targetBytes)}GB. DỪNG. Cần can thiệp tay.`,
      );
    }
  }

  /**
   * Duyệt cây tìm ứng viên — CHỈ gọi khi đã ở mức hành động.
   *
   * Cắt tỉa theo tên thư mục `YYYY/MM/DD`: bỏ nguyên thư mục ngày trẻ hơn sàn
   * mà không stat file nào. Ở Đại Kim cây có ~15k file (500 file/ngày × 30
   * ngày) — cắt tỉa xong chỉ còn phần cũ hơn 7 ngày cần liệt kê.
   *
   * Loại trừ:
   *   - `_clips` (v1 không đụng clip).
   *   - Thư mục ngày HÔM NAY của cam đang ghi (chứa file đang mở).
   */
  private async listSegmentCandidates(): Promise<SegmentCandidate[]> {
    const root = this.deps.recordingRoot;
    const out: SegmentCandidate[] = [];
    const floorCutoffMs = Date.now() - this.floorDays * DAY_MS;

    let camDirs: import("node:fs").Dirent[];
    try {
      camDirs = await withTimeout(
        fs.readdir(root, { withFileTypes: true }),
        this.fsTimeoutMs,
        "readdir root",
      );
    } catch (err) {
      console.error(`[disk-guard] không đọc được ${root}: ${(err as Error).message}`);
      return out;
    }

    for (const cam of camDirs) {
      if (!cam.isDirectory()) continue;
      if (cam.name === CLIPS_SUBDIR) continue;
      const camDir = path.join(root, cam.name);

      for (const y of await this.safeReaddirNames(camDir)) {
        const yDir = path.join(camDir, y);
        for (const m of await this.safeReaddirNames(yDir)) {
          const mDir = path.join(yDir, m);
          for (const d of await this.safeReaddirNames(mDir)) {
            const dayMs = parseDayDirMs(y, m, d);
            if (dayMs === null) continue;
            // Cắt tỉa: cả thư mục ngày trẻ hơn sàn → bỏ, không stat file nào.
            if (dayMs + DAY_MS + TZ_SLACK_MS > floorCutoffMs) continue;
            const dDir = path.join(mDir, d);
            for (const f of await this.safeReaddirNames(dDir)) {
              if (!f.toLowerCase().endsWith(".mp4")) continue;
              out.push({
                absPath: path.join(dDir, f),
                dayMs,
                cameraCode: cam.name,
              });
            }
          }
        }
      }
    }
    return out;
  }

  private async safeReaddirNames(dir: string): Promise<string[]> {
    try {
      return await withTimeout(fs.readdir(dir), this.fsTimeoutMs, "readdir");
    } catch {
      return [];
    }
  }
}
