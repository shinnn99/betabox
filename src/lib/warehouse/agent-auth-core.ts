import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure core cho HMAC agent auth. Tách khỏi `agent-auth.ts` (file kia có
 * `import "server-only"` + nonce store DB) để test được không cần Supabase.
 *
 * B1.3: hỗ trợ 2 protocol version song song trong window rollout.
 *
 *   V1 (legacy, current agents):
 *     canonical = `${timestamp}.${rawBody}`
 *     replay window ±5 phút; không có nonce.
 *
 *   V2 (mới, chống replay):
 *     canonical = `v2\n${agentCode}\n${method}\n${path}\n${bodySha256Hex}\n${timestamp}\n${nonce}`
 *     Consume nonce atomic ở DB. Duplicate nonce = replay = reject.
 *
 * Version signal: header `x-agent-sig-version`.
 *   Không có header (hoặc = "v1") → verify v1.
 *   = "v2" → verify v2.
 */

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const NONCE_SAFETY_BUFFER_MS = 60 * 1000; // 1 phút buffer sau skew.

export type SignatureVersion = "v1" | "v2";

export interface AgentAuthHeadersV1 {
  version: "v1";
  code: string;
  timestamp: string;
  signature: string;
}

export interface AgentAuthHeadersV2 {
  version: "v2";
  code: string;
  timestamp: string;
  signature: string;
  nonce: string;
}

export type AgentAuthHeaders = AgentAuthHeadersV1 | AgentAuthHeadersV2;

export type AgentAuthFailure =
  | { ok: false; status: 400; error: "missing_headers" }
  | { ok: false; status: 400; error: "bad_timestamp" }
  | { ok: false; status: 400; error: "bad_nonce" }
  | { ok: false; status: 401; error: "timestamp_skew" }
  | { ok: false; status: 401; error: "bad_signature" }
  | { ok: false; status: 401; error: "replay_rejected" };

export interface AgentAuthSuccess {
  ok: true;
  version: SignatureVersion;
}

/**
 * Parse headers từ Request. Trả null nếu thiếu field bắt buộc theo
 * version.
 *
 * Rule:
 *   x-agent-code, x-agent-timestamp, x-agent-signature: cả 2 version cần.
 *   x-agent-sig-version = "v2" + x-agent-nonce: chỉ v2.
 */
export function readAgentHeadersFromRecord(
  get: (name: string) => string | null,
): AgentAuthHeaders | null {
  const code = get("x-agent-code");
  const timestamp = get("x-agent-timestamp");
  const signature = get("x-agent-signature");
  if (!code || !timestamp || !signature) return null;

  const versionHeader = (get("x-agent-sig-version") ?? "v1").toLowerCase();
  if (versionHeader === "v2") {
    const nonce = get("x-agent-nonce");
    if (!nonce) return null;
    return { version: "v2", code, timestamp, signature, nonce };
  }
  return { version: "v1", code, timestamp, signature };
}

export function parseTimestampMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

/**
 * Validate nonce format: 8-128 chars, chỉ ký tự URL-safe. Chống DoS
 * bảng bằng nonce dài + chống inject SQL/log tuy Supabase parameterize
 * đã safe.
 */
const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function validateNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

/**
 * V1 canonical: `${timestamp}.${rawBody}`.
 */
export function canonicalV1(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * V2 canonical: `v2\n${code}\n${method}\n${path}\n${bodySha256Hex}\n${timestamp}\n${nonce}`.
 *
 * Method uppercase để chuẩn hoá.
 * Path là canonical URL path (đã strip query string).
 * Body SHA-256 hex lowercase.
 */
export function canonicalV2(params: {
  code: string;
  method: string;
  canonicalPath: string;
  bodySha256Hex: string;
  timestamp: string;
  nonce: string;
}): string {
  return [
    "v2",
    params.code,
    params.method.toUpperCase(),
    params.canonicalPath,
    params.bodySha256Hex.toLowerCase(),
    params.timestamp,
    params.nonce,
  ].join("\n");
}

export function bodySha256Hex(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

function timingSafeCompareHex(expected: string, got: string): boolean {
  const g = got.trim().toLowerCase();
  if (g.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(g, "utf8");
  return timingSafeEqual(a, b);
}

/**
 * Verify signature v1 (legacy). Không consume nonce.
 */
export function verifySignatureV1(params: {
  rawBody: string;
  headers: AgentAuthHeadersV1;
  secret: string;
  now?: number;
}): AgentAuthSuccess | AgentAuthFailure {
  const now = params.now ?? Date.now();
  const ts = parseTimestampMs(params.headers.timestamp);
  if (ts === null) return { ok: false, status: 400, error: "bad_timestamp" };
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: "timestamp_skew" };
  }

  const message = canonicalV1(params.headers.timestamp, params.rawBody);
  const expected = createHmac("sha256", params.secret)
    .update(message)
    .digest("hex");

  if (!timingSafeCompareHex(expected, params.headers.signature)) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  return { ok: true, version: "v1" };
}

/**
 * Verify signature v2 phần chữ ký + timestamp + nonce format. KHÔNG
 * consume nonce (caller phải gọi consumer sau khi verify signature OK).
 *
 * Tách 2 bước để: (a) không consume nonce cho request signature invalid
 * (chống DoS), (b) test được không cần DB.
 */
export function verifySignatureV2(params: {
  rawBody: string;
  method: string;
  canonicalPath: string;
  headers: AgentAuthHeadersV2;
  secret: string;
  now?: number;
}): AgentAuthSuccess | AgentAuthFailure {
  const now = params.now ?? Date.now();
  const ts = parseTimestampMs(params.headers.timestamp);
  if (ts === null) return { ok: false, status: 400, error: "bad_timestamp" };
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: "timestamp_skew" };
  }

  if (!validateNonce(params.headers.nonce)) {
    return { ok: false, status: 400, error: "bad_nonce" };
  }

  const bodyHash = bodySha256Hex(params.rawBody);
  const message = canonicalV2({
    code: params.headers.code,
    method: params.method,
    canonicalPath: params.canonicalPath,
    bodySha256Hex: bodyHash,
    timestamp: params.headers.timestamp,
    nonce: params.headers.nonce,
  });
  const expected = createHmac("sha256", params.secret)
    .update(message)
    .digest("hex");

  if (!timingSafeCompareHex(expected, params.headers.signature)) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  return { ok: true, version: "v2" };
}

/**
 * Tính expires_at cho nonce từ timestamp header.
 */
export function computeNonceExpiresAt(timestampMs: number): Date {
  return new Date(timestampMs + MAX_CLOCK_SKEW_MS + NONCE_SAFETY_BUFFER_MS);
}
