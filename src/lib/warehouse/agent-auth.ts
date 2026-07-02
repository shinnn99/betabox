import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface AgentAuthHeaders {
  code: string;
  timestamp: string;
  signature: string;
}

export type AgentAuthFailure =
  | { ok: false; status: 400; error: "missing_headers" }
  | { ok: false; status: 400; error: "bad_timestamp" }
  | { ok: false; status: 401; error: "timestamp_skew" }
  | { ok: false; status: 401; error: "bad_signature" };

export interface AgentAuthSuccess {
  ok: true;
}

export function readAgentHeaders(req: Request): AgentAuthHeaders | null {
  const code = req.headers.get("x-agent-code");
  const timestamp = req.headers.get("x-agent-timestamp");
  const signature = req.headers.get("x-agent-signature");
  if (!code || !timestamp || !signature) return null;
  return { code, timestamp, signature };
}

function parseTimestampMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

export function verifyAgentSignature(params: {
  rawBody: string;
  headers: AgentAuthHeaders;
  secret: string;
  now?: number;
}): AgentAuthSuccess | AgentAuthFailure {
  const { rawBody, headers, secret } = params;
  const now = params.now ?? Date.now();

  const ts = parseTimestampMs(headers.timestamp);
  if (ts === null) return { ok: false, status: 400, error: "bad_timestamp" };
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: "timestamp_skew" };
  }

  const message = `${headers.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(message).digest("hex");

  const got = headers.signature.trim().toLowerCase();
  if (got.length !== expected.length) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  return { ok: true };
}
