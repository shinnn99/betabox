import { promises as fs } from "node:fs";
import path from "node:path";
import { RepeatNotifier } from "./disk-guard";

/**
 * Phát lại log `cleanup-segments.ps1` lên cloud + báo động khi nó IM LẶNG.
 *
 * Cảnh:
 *   Script dọn chạy hàng tuần qua Task Scheduler, ghi log ra
 *   `<AgentDir>\logs\cleanup-segments.log`. KHÔNG AI chuyển file đó đi đâu.
 *   Ngày 2026-08-23 là lần đầu script thực sự phải xoá thứ gì đó — trên kho
 *   khách, không có ai bấm nút — và ba kết cục (xoá đúng, không xoá gì,
 *   exit 2 vì thiếu cache) nhìn từ Hà Nội giống hệt nhau.
 *
 *   Kênh đã có sẵn: console.warn/console.error được remote-logger patch và
 *   đẩy lên `agent_log_events`. Script không dùng được kênh đó (process
 *   riêng, không ký HMAC) — nên agent đọc hộ.
 *
 * Hai chiều, và chiều thứ hai mới là chiều khó:
 *
 *   1. PHÁT LẠI NỘI DUNG — dòng ERROR và dòng tổng kết của các lượt mới.
 *      Nhớ vị trí đã đọc để không phát lại cùng một dòng mỗi ngày (cùng
 *      tinh thần chống ngập đã làm cho disk guard).
 *
 *   2. BÁO IM LẶNG — kết cục nguy hiểm nhất là script KHÔNG CHẠY (task bị
 *      tắt/xoá, máy tắt đúng giờ đó). Lúc đó không có dòng log nào để phát,
 *      và im lặng trông giống hệt "mọi thứ bình thường". Nên đo mtime file
 *      log: cũ hơn hai chu kỳ dọn → báo động, không cần biết nội dung.
 *
 * Điểm mtime KHÔNG trả lời được, nên phần nội dung phải gánh: một lượt
 * `exit 2` cũng ghi log, cũng làm mtime tươi. Mà `exit 2` là trạng thái TỰ
 * DUY TRÌ — cache thiếu tuần này thì tuần sau vẫn thiếu, script sẽ exit 2
 * mãi trong khi mtime tuần nào cũng mới. Vì vậy có nhánh `ranWithoutCleanup`
 * riêng: chạy mà KHÔNG dọn được là báo động, không phải tin vui.
 */

export interface CleanupLogAnalysis {
  /** Dòng `[ERROR]` mới kể từ lần đọc trước. */
  errorLines: string[];
  /** Dòng `Cleanup done` mới nhất trong phần mới đọc (null nếu không có). */
  lastSummary: string | null;
  /** Có ERROR mà không có lượt dọn nào hoàn tất — trạng thái tự duy trì. */
  ranWithoutCleanup: boolean;
}

const ERROR_MARK = "[ERROR]";
const SUMMARY_MARK = "Cleanup done";

export function analyzeCleanupLines(lines: string[]): CleanupLogAnalysis {
  const errorLines: string[] = [];
  let lastSummary: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.includes(ERROR_MARK)) errorLines.push(line);
    if (line.includes(SUMMARY_MARK)) lastSummary = line;
  }
  return {
    errorLines,
    lastSummary,
    ranWithoutCleanup: errorLines.length > 0 && lastSummary === null,
  };
}

interface RelayState {
  offset: number;
  size: number;
}

export interface CleanupLogRelayDeps {
  /** `<cwd>/logs/cleanup-segments.log` — cùng quy ước với retention-cache. */
  logPath: string;
  /** Nơi nhớ vị trí đã đọc, để agent restart không phát lại từ đầu. */
  statePath: string;
}

export interface CleanupLogRelayOptions {
  /** Nhịp kiểm. Mặc định 6 giờ — script chạy hàng tuần, không cần dày hơn. */
  checkIntervalMs?: number;
  /**
   * Ngưỡng im lặng. Mặc định 15 ngày = 2 chu kỳ tuần + đệm, để một lần lỡ
   * (máy tắt đúng Chủ nhật) không báo động ngay, nhưng hai lần liên tiếp thì
   * có.
   */
  silenceThresholdMs?: number;
  /** Trần số dòng ERROR phát mỗi lượt, chống ngập nếu log đầy lỗi. */
  maxEmitLines?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class CleanupLogRelay {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private warnedMissing = false;
  private readonly notifier = new RepeatNotifier();
  private readonly checkIntervalMs: number;
  private readonly silenceThresholdMs: number;
  private readonly maxEmitLines: number;

  constructor(
    private readonly deps: CleanupLogRelayDeps,
    opts: CleanupLogRelayOptions = {},
  ) {
    this.checkIntervalMs = opts.checkIntervalMs ?? 6 * 60 * 60_000;
    this.silenceThresholdMs = opts.silenceThresholdMs ?? 15 * DAY_MS;
    this.maxEmitLines = opts.maxEmitLines ?? 20;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check().catch((err) => {
        console.warn(`[cleanup-log] check error: ${(err as Error).message}`);
      });
    }, this.checkIntervalMs);
    this.timer.unref?.();
    void this.check().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(this.deps.logPath);
      } catch {
        // Chưa có log = script chưa chạy lần nào. Ở máy vừa cài thì bình
        // thường (chờ tới Chủ nhật đầu tiên); ở máy chạy lâu rồi thì bất
        // thường. Không có mốc nào để phân biệt tại chỗ, nên báo MỘT LẦN
        // lúc khởi động thay vì kêu định kỳ — tránh máy mới cài kêu suốt
        // tuần đầu.
        if (!this.warnedMissing) {
          this.warnedMissing = true;
          console.warn(
            `[cleanup-log] chưa có log dọn segment tại ${this.deps.logPath} — ` +
              `script cleanup chưa chạy lần nào. Bình thường nếu agent vừa cài; ` +
              `bất thường nếu đã chạy quá 2 tuần (kiểm Task Scheduler).`,
          );
        }
        return;
      }

      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > this.silenceThresholdMs) {
        if (this.notifier.shouldNotify("silence", Date.now())) {
          console.error(
            `[cleanup-log] IM LẶNG: log dọn segment không được cập nhật ` +
              `${Math.round(ageMs / DAY_MS)} ngày (ngưỡng ` +
              `${Math.round(this.silenceThresholdMs / DAY_MS)}). Script dọn hàng ` +
              `tuần nhiều khả năng KHÔNG CHẠY — kiểm Task Scheduler trên máy kho. ` +
              `Không dọn thì đĩa đầy dần cho tới khi disk guard phải kích hoạt.`,
          );
        }
      } else if (this.notifier.clear("silence")) {
        console.warn("[cleanup-log] log dọn segment đã được cập nhật trở lại");
      }

      const state = await this.readState();
      // File ngắn hơn vị trí đã đọc = bị cắt/xoay vòng → đọc lại từ đầu.
      const truncated = stat.size < state.offset;
      const from = truncated ? 0 : state.offset;
      if (truncated) {
        console.warn(
          "[cleanup-log] file log ngắn lại (bị xoay vòng hoặc cắt) — đọc lại từ đầu",
        );
      }
      if (stat.size === from) {
        await this.writeState({ offset: stat.size, size: stat.size });
        return;
      }

      const buf = await fs.readFile(this.deps.logPath, "utf8");
      const fresh = buf.slice(from);
      await this.writeState({ offset: buf.length, size: stat.size });

      const analysis = analyzeCleanupLines(fresh.split(/\r?\n/));
      if (analysis.errorLines.length > 0) {
        for (const line of analysis.errorLines.slice(-this.maxEmitLines)) {
          console.error(`[cleanup-log] ${line}`);
        }
        if (analysis.errorLines.length > this.maxEmitLines) {
          console.error(
            `[cleanup-log] (còn ${analysis.errorLines.length - this.maxEmitLines} ` +
              `dòng ERROR nữa bị lược — đọc log trên máy kho)`,
          );
        }
      }
      if (analysis.ranWithoutCleanup) {
        console.error(
          "[cleanup-log] script dọn CÓ CHẠY nhưng KHÔNG dọn được lượt nào " +
            "(exit 2). Đây là trạng thái tự duy trì: nguyên nhân còn đó thì " +
            "tuần sau vẫn hỏng, trong khi mtime log vẫn tươi nên tín hiệu im " +
            "lặng KHÔNG bắt được. Xử nguyên nhân ở dòng ERROR bên trên.",
        );
      } else if (analysis.lastSummary !== null) {
        console.warn(`[cleanup-log] ${analysis.lastSummary}`);
      }
    } finally {
      this.checking = false;
    }
  }

  private async readState(): Promise<RelayState> {
    try {
      const raw = await fs.readFile(this.deps.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RelayState>;
      if (typeof parsed.offset === "number" && parsed.offset >= 0) {
        return { offset: parsed.offset, size: parsed.size ?? 0 };
      }
    } catch {
      /* chưa có state hoặc hỏng → đọc từ đầu */
    }
    return { offset: 0, size: 0 };
  }

  private async writeState(state: RelayState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.deps.statePath), { recursive: true });
      const tmp = `${this.deps.statePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state), "utf8");
      await fs.rename(tmp, this.deps.statePath);
    } catch (err) {
      console.warn(`[cleanup-log] ghi state thất bại: ${(err as Error).message}`);
    }
  }
}
