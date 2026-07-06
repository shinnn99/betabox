/**
 * Fatal handlers cho agent chạy 24/7 ở kho.
 *
 * Nếu KHÔNG có handler top-level, Node 15+ default = crash process khi
 * unhandledRejection. Agent .exe chết im lặng ở kho, không log, không
 * ai biết cho đến khi user báo camera không ghi.
 *
 * Handler này:
 *   1. Log structured để đọc được từ Windows Event Viewer / service log.
 *   2. Với uncaughtException: exit với code khác 0 để service manager
 *      (ssInstall/SCM) tự restart.
 *   3. Với unhandledRejection: log + tăng counter, KHÔNG exit ngay
 *      (một số reject là bug logic đơn lẻ, không cần crash toàn agent).
 *      Nếu vượt ngưỡng trong cửa sổ 1 phút → coi như hệ vỡ, exit.
 *
 * `swallow(promise, tag)` là helper thay `void promise` — bắt lỗi lộ ra
 * top-level (thay vì rơi vào unhandledRejection). Mỗi callsite có `tag`
 * để log rõ chỗ nào reject.
 */

const REJECT_WINDOW_MS = 60_000;
const REJECT_THRESHOLD = 20;

let recentRejections: number[] = [];
let installed = false;

function pruneRejectWindow(now: number): void {
  const cutoff = now - REJECT_WINDOW_MS;
  recentRejections = recentRejections.filter((ts) => ts >= cutoff);
}

export function installFatalHandlers(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const now = Date.now();
    recentRejections.push(now);
    pruneRejectWindow(now);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error(
      `[FATAL unhandledRejection] count_in_window=${recentRejections.length} message=${err.message}`,
    );
    if (err.stack) console.error(err.stack);
    if (recentRejections.length >= REJECT_THRESHOLD) {
      console.error(
        `[FATAL unhandledRejection] threshold ${REJECT_THRESHOLD}/${REJECT_WINDOW_MS}ms exceeded — exiting so service manager restarts`,
      );
      // Không await flush I/O — Windows service manager sẽ restart process.
      process.exit(1);
    }
  });

  process.on("uncaughtException", (err) => {
    console.error(`[FATAL uncaughtException] message=${err.message}`);
    if (err.stack) console.error(err.stack);
    // Uncaught exception → state không xác định. Exit ngay để SCM restart.
    process.exit(1);
  });
}

/**
 * Thay `void promise` bằng `swallow(promise, tag)`.
 *
 * Nếu promise reject, log tag + error thay vì rơi vào unhandledRejection.
 * Vẫn giữ tính chất fire-and-forget (không await), nhưng lỗi không mất.
 */
export function swallow(promise: Promise<unknown>, tag: string): void {
  promise.catch((err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[swallow:${tag}] ${e.message}`);
    if (e.stack) console.error(e.stack);
  });
}
