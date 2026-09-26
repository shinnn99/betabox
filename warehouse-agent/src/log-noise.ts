/**
 * Gom nhiễu log (bản 0.13.0, kế hoạch VAN-HANH-NHIEU-KHO đợt 8 phía agent).
 *
 * Đo 7 ngày ở một kho: 26.990 dòng `agent_log_events`, 77% nhiễu —
 * `[qr-frame-source]` một mình 20.948 dòng. 528 lần FATAL và 525 lần MediaMTX
 * chết nằm im trong đống đó không ai được báo (kế hoạch 3.2).
 *
 * Hai thứ ở đây:
 *   - `RepeatCollapser`: cùng một câu (sau khi bỏ số, mã hex, id) lặp lại
 *     trong một khoảng → gửi lần đầu, các lần sau chỉ đếm, hết khoảng gửi
 *     MỘT dòng "(lặp N lần)". Lỗi thật vẫn tới ngay lần đầu; chỉ phần lặp
 *     bị gom.
 *   - `RollingCounter`: đếm sự kiện trong một giờ trượt — nhiễu giải mã
 *     ffmpeg thành TỈ LỆ ("CQR01: 3.000 khung hỏng/giờ") trong bản tự khai,
 *     để cloud phán, thay vì thành dòng log.
 *
 * Khoảng gom nhận từ cloud (`runtime-tuning.ts`) — đổi độ ồn không cần bản
 * agent mới.
 *
 * Hàm / lớp thuần, đồng hồ tiêm vào được cho test.
 */

export type Level = "warn" | "error";

/** Khoá so trùng: bỏ những phần đổi mỗi lần (số, hex, uuid, giờ). */
export function noiseKey(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

interface Entry {
  level: Level;
  firstAtMs: number;
  suppressed: number;
  sample: string;
}

const MAX_KEYS = 500;

export class RepeatCollapser {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly windowMs: () => number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Nên gửi câu này ngay không. `true` = lần đầu trong khoảng (gửi);
   * `false` = lặp lại (đã đếm, không gửi).
   */
  admit(level: Level, message: string): boolean {
    const key = `${level}|${noiseKey(message)}`;
    const t = this.now();
    const e = this.entries.get(key);
    if (e && t - e.firstAtMs < this.windowMs()) {
      e.suppressed++;
      e.sample = message;
      return false;
    }
    // Khoảng cũ đã hết mà còn phần lặp chưa báo: `drainExpired` lo — ở đây
    // chỉ mở khoảng mới. (Người gọi luôn drain trước mỗi lượt gửi.)
    if (!e && this.entries.size >= MAX_KEYS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { level, firstAtMs: t, suppressed: 0, sample: message });
    return true;
  }

  /** Dòng tóm tắt cho mọi khoảng đã hết có phần lặp. */
  drainExpired(): Array<{ level: Level; message: string }> {
    const t = this.now();
    const out: Array<{ level: Level; message: string }> = [];
    for (const [key, e] of this.entries) {
      if (t - e.firstAtMs < this.windowMs()) continue;
      if (e.suppressed > 0) {
        const minutes = Math.max(1, Math.round((t - e.firstAtMs) / 60_000));
        out.push({ level: e.level, message: `(lặp lại ${e.suppressed} lần trong ${minutes} phút) ${e.sample}` });
      }
      this.entries.delete(key);
    }
    return out;
  }
}

/** Đếm sự kiện trong 60 phút trượt, theo ô một phút. */
export class RollingCounter {
  private readonly buckets = new Map<number, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(n = 1): void {
    const minute = Math.floor(this.now() / 60_000);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + n);
    this.prune(minute);
  }

  lastHour(): number {
    const minute = Math.floor(this.now() / 60_000);
    this.prune(minute);
    let total = 0;
    for (const v of this.buckets.values()) total += v;
    return total;
  }

  private prune(currentMinute: number): void {
    for (const m of this.buckets.keys()) if (m <= currentMinute - 60) this.buckets.delete(m);
  }
}
