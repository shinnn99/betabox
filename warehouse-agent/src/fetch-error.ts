/**
 * Node `fetch` (undici) throws `TypeError: fetch failed` khi tầng dưới
 * (DNS / TCP / TLS) hỏng, và giấu chi tiết vào `err.cause`. Chỉ đọc
 * `err.message` mất tất cả context để phân biệt ECONNREFUSED vs
 * CERT_HAS_EXPIRED vs EAI_AGAIN vs bị Windows firewall chặn.
 *
 * Hàm này rút gọn `err.cause` thành 1 dòng có code/errno/syscall/hostname
 * để log ra là chẩn được ngay tầng nào hỏng.
 */
export function describeFetchError(err: unknown): string {
  const top = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (!cause) return top;

  const c = cause as {
    code?: string;
    errno?: number | string;
    syscall?: string;
    hostname?: string;
    address?: string;
    port?: number;
    message?: string;
  };
  const parts: string[] = [];
  if (c.code) parts.push(`code=${c.code}`);
  if (c.errno !== undefined) parts.push(`errno=${c.errno}`);
  if (c.syscall) parts.push(`syscall=${c.syscall}`);
  if (c.hostname) parts.push(`host=${c.hostname}`);
  if (c.address) parts.push(`addr=${c.address}${c.port ? `:${c.port}` : ""}`);
  if (c.message && !parts.length) parts.push(c.message);
  return parts.length ? `${top} (${parts.join(" ")})` : top;
}

/**
 * Extract `err.cause.code` từ TypeError của undici fetch. Trả null nếu
 * không phải lỗi mạng (VD error cấu trúc khác, string thô).
 */
function getFetchErrorCode(err: unknown): string | null {
  const cause = (err as { cause?: unknown })?.cause;
  if (!cause) return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Lỗi mạng transient — retry có nghĩa.
 *
 * Vercel POP hkg1 (APAC) reset socket không đều đặn, gặp mọi endpoint
 * (không chỉ discovery/heartbeat), không đều theo body size. Fix
 * `tls.DEFAULT_MAX_VERSION = 'TLSv1.2'` ở top index.ts áp cho
 * `node:https` cổ điển; undici fetch (Node 24 default) có bộ TLS
 * riêng, không đọc setting đó. Nên fetch tới `*.vercel.app` vẫn có
 * thể ECONNRESET intermittent kể cả sau khi ép TLS 1.2.
 *
 * Bằng chứng: test 2 lần liên tiếp cùng shell — lần 1 fail, lần 2 OK.
 * Retry là lưới đúng, không phải patch bừa.
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function isRetryableFetchError(err: unknown): boolean {
  const code = getFetchErrorCode(err);
  return code !== null && RETRYABLE_CODES.has(code);
}

export interface FetchWithRetryOptions {
  /** Số lần thử (bao gồm lần đầu). Mặc định 4 → tối đa 3 retry. */
  maxAttempts?: number;
  /** Delay lần đầu (ms). Mặc định 500ms. */
  initialDelayMs?: number;
  /** Hệ số nhân delay mỗi lần. Mặc định 3 → 500ms, 1500ms, 4500ms. */
  backoffFactor?: number;
  /** Label để log (không dùng cho logic — chỉ debug). */
  label?: string;
  /**
   * Timeout MỖI attempt (ms). Bảo vệ chống Vercel POP hang (socket
   * open không response). Không đặt = fetch treo vô hạn → poll queue
   * chồng lên nhau → memory leak, agent zombie.
   *
   * CỨNG: tách theo loại request. Poll/heartbeat/probe = 30s. Upload
   * clip file lớn cần 5-10 phút — CALLER phải pass timeoutMs riêng.
   * Không đặt default cứng ở đây vì mỗi endpoint khác nhau.
   *
   * `undefined` = KHÔNG timeout (giữ nguyên hành vi cũ, chỉ dùng khi
   * caller đã có timeout riêng bên ngoài như uploadWithTimeout).
   */
  timeoutMs?: number;
}

/**
 * Wrap fetch với AbortController timeout. Trả về response nếu OK,
 * throw error nếu timeout hoặc network fail.
 */
async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number | undefined,
): Promise<Response> {
  if (timeoutMs === undefined) return fetch(input, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrapper fetch với retry+backoff cho lỗi mạng transient.
 *
 * KHÔNG retry cho response HTTP 4xx/5xx — đó là backend đã trả lời,
 * không phải network fault. Retry response có thể tạo side-effect kép
 * (VD POST insert row 2 lần).
 *
 * Delay mặc định: 500ms → 1500ms → 4500ms = tối đa ~6.5s cho 3 retry.
 * Nếu vẫn fail sau đó, throw lỗi cuối để caller quyết.
 *
 * Không nuốt lỗi cuối — caller phải biết fetch fail để có thể fallback
 * (VD queue lại, log đúng chỗ, dừng loop hiện tại).
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? 4;
  const initialDelayMs = options?.initialDelayMs ?? 500;
  const backoffFactor = options?.backoffFactor ?? 3;
  const timeoutMs = options?.timeoutMs;

  let lastErr: unknown;
  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchWithTimeout(input, init, timeoutMs);
    } catch (err) {
      lastErr = err;
      // AbortError từ timeout retry được (giống network fail).
      const isTimeout = (err as Error)?.name === "AbortError";
      if (!isTimeout && !isRetryableFetchError(err)) throw err;
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= backoffFactor;
    }
  }
  throw lastErr;
}

/**
 * Biến thể cho request HMAC v2: mỗi attempt phải sinh headers mới (nonce
 * mới + timestamp mới). Nếu tái dùng RequestInit cũ, backend reject
 * attempt sau là replay.
 *
 * Caller pass `initFactory` — trả về RequestInit mới mỗi lần gọi (ký lại
 * body → sinh nonce + timestamp). Body string giống nhau giữa các
 * attempt để backend đọc body content chuẩn; chỉ headers đổi.
 */
export async function fetchWithRetrySigned(
  input: string | URL,
  initFactory: () => RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? 4;
  const initialDelayMs = options?.initialDelayMs ?? 500;
  const backoffFactor = options?.backoffFactor ?? 3;
  // Default 30s cho poll/heartbeat/probe — đủ dài cho mạng flake, đủ ngắn
  // để không kẹt agent lâu. CALLER upload clip file lớn PHẢI override
  // (uploadWithTimeout đã có timeout riêng bên ngoài).
  const timeoutMs = options?.timeoutMs ?? 30_000;

  let lastErr: unknown;
  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchWithTimeout(input, initFactory(), timeoutMs);
    } catch (err) {
      lastErr = err;
      const isTimeout = (err as Error)?.name === "AbortError";
      if (!isTimeout && !isRetryableFetchError(err)) throw err;
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= backoffFactor;
    }
  }
  throw lastErr;
}

/**
 * Log rate limiter theo key. Mục đích: chặn spam log khi cùng một lỗi
 * lặp lại liên tục (VD Vercel POP reset gặp mỗi 15s → 240 dòng/giờ).
 *
 * Chiến lược "log đầu + im lặng + tổng kết":
 *   - Log DUY NHẤT lần đầu gặp (key mới).
 *   - Các lần sau cùng key: im lặng, đếm.
 *   - Sau `summaryIntervalMs` (mặc định 5 phút), nếu key vẫn được gọi:
 *     log 1 dòng tổng "still failing: <count> lần trong 5m", reset count.
 *   - Nếu key im lặng vượt `resetAfterMs`: coi như "đã hết lỗi", quên
 *     key. Lần tiếp theo lại log lần đầu (không nuốt lỗi mới).
 *
 * Dùng qua closure `getLimiter(key)` — mỗi key nhớ state riêng.
 */
export class LogRateLimiter {
  private state = new Map<
    string,
    { firstAt: number; lastAt: number; count: number; lastSummaryAt: number }
  >();

  constructor(
    private readonly summaryIntervalMs: number = 5 * 60 * 1000,
    private readonly resetAfterMs: number = 10 * 60 * 1000,
  ) {}

  /**
   * Gọi mỗi lần muốn log. Trả về "log_first" / "silent" / "log_summary".
   * Caller tự log text theo verdict.
   *
   * Ví dụ:
   *   const v = limiter.tick("discovery:ECONNRESET");
   *   if (v.kind === "log_first") console.error(`[discovery] POST fail: ${msg}`);
   *   else if (v.kind === "log_summary") console.error(`[discovery] still failing: ${v.count} lần trong 5m`);
   */
  tick(key: string): TickResult {
    const now = Date.now();
    const s = this.state.get(key);

    // Chưa từng thấy key này, hoặc đã reset (im lặng đủ lâu).
    if (!s || now - s.lastAt > this.resetAfterMs) {
      this.state.set(key, {
        firstAt: now,
        lastAt: now,
        count: 1,
        lastSummaryAt: now,
      });
      return { kind: "log_first" };
    }

    s.lastAt = now;
    s.count += 1;

    // Đã tới thời điểm summary.
    if (now - s.lastSummaryAt >= this.summaryIntervalMs) {
      const count = s.count;
      s.lastSummaryAt = now;
      s.count = 0; // reset count sau khi summary
      return { kind: "log_summary", count };
    }

    return { kind: "silent" };
  }
}

export type TickResult =
  | { kind: "log_first" }
  | { kind: "silent" }
  | { kind: "log_summary"; count: number };
