/**
 * Bounded-timeout upload cho signed URL PUT lên Supabase Storage.
 *
 * CRIT-4: `fetch(signedUrl, { method: "PUT", body })` không timeout →
 * nếu Supabase APAC POP treo (socket giữ open, không response), agent
 * kẹt VÔ HẠN. Pipeline clip queue lại → clip tiếp không cắt được.
 *
 * Chiến lược:
 *   - AbortController + timeout tỉ lệ file size (base + size/MB * per_mb_ms),
 *     kẹp min/max.
 *   - Phân loại lỗi rõ:
 *       - "timeout"      → retryable (mạng chậm bất thường)
 *       - "network"      → retryable (ECONNRESET, ETIMEDOUT, EAI_AGAIN...)
 *       - "http_5xx"     → retryable (backend fault)
 *       - "http_4xx"     → non-retryable (auth/policy/body sai; retry vô nghĩa)
 *       - "aborted"      → do external abort (shutdown), KHÔNG retry
 *   - Retry với exponential backoff + jitter, giới hạn attempt.
 *   - Không log URL (chứa signed token) hoặc body content.
 *   - Không giữ resource: dùng finally để clear timer.
 *
 * Không đụng encode-gate: gate chỉ ôm bước cut (STEP 3), không ôm upload
 * (STEP 6). Upload treo → gate không giữ.
 */

export type UploadErrorKind =
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "aborted";

export interface UploadResult {
  ok: boolean;
  attempts: number;
  totalElapsedMs: number;
  /** Chỉ set khi ok=false. */
  errorKind?: UploadErrorKind;
  /** Message rút gọn (không chứa URL/body). */
  errorMessage?: string;
  /** HTTP status nếu là http_4xx/http_5xx. */
  httpStatus?: number;
}

export interface UploadWithTimeoutOptions {
  /** Timeout tối thiểu (ms). Mặc định 30s. */
  minTimeoutMs?: number;
  /** Timeout tối đa (ms). Mặc định 5 phút (kho mạng chậm). */
  maxTimeoutMs?: number;
  /** Base timeout (ms) độc lập size. Mặc định 20s. */
  baseTimeoutMs?: number;
  /** Cộng thêm mỗi MB body. Mặc định 3s/MB (mạng kho ~300KB/s worst). */
  perMbMs?: number;
  /** Số lần thử tối đa (bao gồm lần đầu). Mặc định 3. */
  maxAttempts?: number;
  /** Delay retry lần đầu (ms). Mặc định 1000ms. */
  initialBackoffMs?: number;
  /** Backoff multiplier. Mặc định 2. */
  backoffFactor?: number;
  /** External abort signal (VD shutdown). Nếu abort → dừng ngay, không retry. */
  externalSignal?: AbortSignal;
  /** Content-Type header. Mặc định "application/octet-stream". */
  contentType?: string;
}

const RETRYABLE_UNDICI_CODES = new Set([
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

function extractUndiciCode(err: unknown): string | null {
  const cause = (err as { cause?: unknown })?.cause;
  if (!cause) return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function computeTimeoutMs(
  bodySize: number,
  opts: UploadWithTimeoutOptions,
): number {
  const base = opts.baseTimeoutMs ?? 20_000;
  const perMb = opts.perMbMs ?? 3_000;
  const min = opts.minTimeoutMs ?? 30_000;
  const max = opts.maxTimeoutMs ?? 300_000;
  const sizeMb = bodySize / (1024 * 1024);
  const raw = base + sizeMb * perMb;
  return Math.max(min, Math.min(max, raw));
}

function jitter(ms: number): number {
  // ±25%
  const spread = ms * 0.25;
  return ms + (Math.random() * 2 - 1) * spread;
}

export async function uploadWithTimeout(
  signedUrl: string,
  body: Buffer,
  opts: UploadWithTimeoutOptions = {},
): Promise<UploadResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialBackoffMs = opts.initialBackoffMs ?? 1000;
  const backoffFactor = opts.backoffFactor ?? 2;
  const contentType = opts.contentType ?? "application/octet-stream";
  const timeoutMs = computeTimeoutMs(body.byteLength, opts);
  const start = Date.now();

  let backoff = initialBackoffMs;
  let lastErrorKind: UploadErrorKind | undefined;
  let lastErrorMessage: string | undefined;
  let lastHttpStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // External abort trước khi thử → dừng.
    if (opts.externalSignal?.aborted) {
      return {
        ok: false,
        attempts: attempt - 1,
        totalElapsedMs: Date.now() - start,
        errorKind: "aborted",
        errorMessage: "aborted before attempt",
      };
    }

    const attemptCtrl = new AbortController();
    const timer = setTimeout(() => attemptCtrl.abort(), timeoutMs);
    const externalListener = () => attemptCtrl.abort();
    if (opts.externalSignal) {
      opts.externalSignal.addEventListener("abort", externalListener, { once: true });
    }

    try {
      const res = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body,
        redirect: "manual",
        signal: attemptCtrl.signal,
      });

      if (res.ok) {
        return {
          ok: true,
          attempts: attempt,
          totalElapsedMs: Date.now() - start,
        };
      }

      // HTTP response nhưng không ok.
      lastHttpStatus = res.status;
      let bodySnippet = "";
      try {
        bodySnippet = (await res.text()).slice(0, 200);
      } catch {
        // Bỏ qua — không log stream đọc dở.
      }
      lastErrorMessage = `http_${res.status}: ${bodySnippet}`;
      if (res.status >= 400 && res.status < 500) {
        // 4xx = backend refuse. Retry vô nghĩa.
        lastErrorKind = "http_4xx";
        return {
          ok: false,
          attempts: attempt,
          totalElapsedMs: Date.now() - start,
          errorKind: lastErrorKind,
          errorMessage: lastErrorMessage,
          httpStatus: res.status,
        };
      }
      // 5xx = retryable.
      lastErrorKind = "http_5xx";
    } catch (err) {
      // Phân loại throw.
      const isAbort =
        (err as Error)?.name === "AbortError" ||
        attemptCtrl.signal.aborted;
      if (isAbort) {
        // External abort hay timeout local? External thắng.
        if (opts.externalSignal?.aborted) {
          return {
            ok: false,
            attempts: attempt,
            totalElapsedMs: Date.now() - start,
            errorKind: "aborted",
            errorMessage: "aborted during request",
          };
        }
        lastErrorKind = "timeout";
        lastErrorMessage = `timeout after ${timeoutMs}ms`;
      } else {
        const code = extractUndiciCode(err);
        if (code && RETRYABLE_UNDICI_CODES.has(code)) {
          lastErrorKind = "network";
          lastErrorMessage = `network ${code}`;
        } else {
          // Lỗi không rõ (TypeError không rõ nguyên nhân, TLS...). Coi
          // như network, cho retry nếu còn attempt — nhưng không vô hạn.
          lastErrorKind = "network";
          lastErrorMessage = `unknown_fetch_error: ${(err as Error)?.message ?? String(err)}`;
        }
      }
    } finally {
      clearTimeout(timer);
      if (opts.externalSignal) {
        opts.externalSignal.removeEventListener("abort", externalListener);
      }
    }

    // Còn attempt không?
    if (attempt < maxAttempts) {
      const wait = jitter(backoff);
      await new Promise((r) => setTimeout(r, wait));
      backoff *= backoffFactor;
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    totalElapsedMs: Date.now() - start,
    errorKind: lastErrorKind,
    errorMessage: lastErrorMessage,
    httpStatus: lastHttpStatus,
  };
}
