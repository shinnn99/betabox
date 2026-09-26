import { signBodyV2 } from "./signing";
import { AGENT_API_PATHS } from "./agent-api-paths";
import { RepeatCollapser } from "./log-noise";
import { tuning } from "./runtime-tuning";

/**
 * Remote logger — bắt console.warn/error, gộp batch, push lên cloud
 * endpoint POST /api/agent/log-events.
 *
 * Thiết kế bản tối thiểu (2026-07-22):
 *   * Chỉ WARN + ERROR. Info/debug quá noise, cần thì mở sau.
 *   * Batch mỗi 30s + flush ngay khi có ERROR (để Hạnh thấy sớm).
 *   * KHÔNG buffer file khi mạng đứt — mất là mất. AnyDesk bù ca đó.
 *   * Trap sau logger khác (v0.7.1 shutdown/watchdog log): wrap console
 *     methods, gọi phương thức gốc trước rồi enqueue.
 *
 * KHÔNG dùng fetchWithRetrySigned vì:
 *   1. Log fail không blocker gì — chấp nhận mất, không retry backoff
 *      3 lần chiếm tài nguyên.
 *   2. Retry có thể gây feedback loop (fail log fail → generate log
 *      "fail log fail" → push lại → fail).
 *
 * Chỉ 1 fetch với timeout ngắn. Fail = silently drop batch.
 */

interface LogEvent {
  level: "warn" | "error";
  message: string;
  emitted_at: string;
}

interface RemoteLoggerConfig {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  enabled: boolean;
  flushIntervalMs: number;
}

const MAX_QUEUE_SIZE = 500;
const MAX_BATCH_SIZE = 100;
const MAX_MESSAGE_LENGTH = 2048;
const PUSH_TIMEOUT_MS = 10_000;
const RECENT_LINES = 50;

export class RemoteLogger {
  private queue: LogEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private pushing = false;
  private originalWarn: typeof console.warn;
  private originalError: typeof console.error;
  private disposed = false;
  /**
   * 0.13.0: cùng một câu lặp lại trong `tuning.logRepeatWindowMs` → gửi lần
   * đầu, phần lặp gom thành một dòng "(lặp N lần)". Khoảng nhận từ cloud.
   */
  private readonly collapser = new RepeatCollapser(() => tuning.logRepeatWindowMs);
  /**
   * 0.13.0: 50 dòng warn/error gần nhất, KỂ CẢ dòng đã gom — cho lệnh thu
   * chẩn đoán. Chỉ ở RAM, không gửi đi trừ khi cloud xin.
   */
  private readonly recentLines: string[] = [];

  constructor(private readonly config: RemoteLoggerConfig) {
    this.originalWarn = console.warn.bind(console);
    this.originalError = console.error.bind(console);
  }

  /** Wrap console.warn/error để bắt log emit trong toàn agent. */
  install(): void {
    if (!this.config.enabled) {
      this.originalWarn("[remote-logger] disabled by config, skip install");
      return;
    }
    const self = this;
    console.warn = function (...args: unknown[]) {
      self.originalWarn(...args);
      self.enqueue("warn", args);
    };
    console.error = function (...args: unknown[]) {
      self.originalError(...args);
      // ERROR = flush ngay (không đợi 30s), để Hạnh thấy sớm — chỉ khi câu
      // được nhận; lỗi lặp lại đã gom thì chờ dòng tóm tắt.
      if (self.enqueue("error", args)) void self.flush();
    };
    this.startTimer();
    this.originalWarn(
      `[remote-logger] installed (flush every ${this.config.flushIntervalMs}ms, url=${this.config.backendUrl}${AGENT_API_PATHS.logEvents})`,
    );
  }

  /** 50 dòng warn/error gần nhất (cả dòng đã gom) — cho `collect_diagnostics`. */
  recent(): string[] {
    return [...this.recentLines];
  }

  /** Gỡ wrap, flush pending (dùng khi shutdown). */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    console.warn = this.originalWarn;
    console.error = this.originalError;
    for (const summary of this.collapser.drainExpired()) this.push(summary.level, summary.message);
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  private startTimer(): void {
    this.flushTimer = setInterval(() => {
      for (const summary of this.collapser.drainExpired()) this.push(summary.level, summary.message);
      if (this.queue.length > 0) {
        void this.flush();
      }
    }, this.config.flushIntervalMs);
    // Cho phép process exit dù timer còn.
    this.flushTimer.unref?.();
  }

  /** true = câu được đưa vào hàng gửi; false = lặp lại, đã gom. */
  private enqueue(level: "warn" | "error", args: unknown[]): boolean {
    if (this.disposed) return false;
    const message = args
      .map((a) => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ")
      .slice(0, MAX_MESSAGE_LENGTH);
    this.recentLines.push(`${new Date().toISOString()} ${level} ${message.slice(0, 500)}`);
    if (this.recentLines.length > RECENT_LINES) this.recentLines.shift();
    if (!this.collapser.admit(level, message)) return false;
    this.push(level, message);
    return true;
  }

  private push(level: "warn" | "error", message: string): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Queue đầy — drop oldest (FIFO). Không log warn vì sẽ tự-lặp.
      this.queue.shift();
    }
    this.queue.push({
      level,
      message,
      emitted_at: new Date().toISOString(),
    });
  }

  private async flush(): Promise<void> {
    if (this.pushing) return; // 1 request in-flight tại 1 thời điểm.
    if (this.queue.length === 0) return;

    this.pushing = true;
    // Lấy tối đa MAX_BATCH_SIZE event, giữ phần còn lại cho lần sau.
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);

    try {
      const body = JSON.stringify({ events: batch });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
      try {
        const res = await fetch(
          `${this.config.backendUrl}${AGENT_API_PATHS.logEvents}`,
          {
            method: "POST",
            headers: signBodyV2({
              agentCode: this.config.agentCode,
              agentSecret: this.config.agentSecret,
              method: "POST",
              canonicalPath: AGENT_API_PATHS.logEvents,
              body,
            }),
            body,
            redirect: "manual",
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          // Silently drop batch. KHÔNG log qua wrapped console (feedback
          // loop). Dùng originalError trực tiếp — không enqueue lại.
          this.originalError(
            `[remote-logger] push failed status=${res.status} dropped=${batch.length}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Timeout/network fail — silently drop, log qua original.
      this.originalError(
        `[remote-logger] push error: ${(err as Error).message} dropped=${batch.length}`,
      );
    } finally {
      this.pushing = false;
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
