// Crypto thuần cho platform org-context signing.
// KHÔNG server-only (không đụng NextRequest) — test được standalone.
// internal-headers.ts re-export các hàm này để proxy/guard import không đổi.

import { createHmac, timingSafeEqual } from "crypto";

const SECRET = process.env.PLATFORM_ORG_CTX_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error(
    "PLATFORM_ORG_CTX_SECRET missing or < 32 chars — required for platform org-context signing"
  );
}

export const INTERNAL_PREFIX = "x-internal-";
export const TOKEN_TTL_MS = 5 * 60 * 1000;

export interface OrgContextPayload {
  orgId: string;
  timestamp: number;
  nonce: string;
}

export async function signOrgContext(payload: OrgContextPayload): Promise<string> {
  const body = JSON.stringify(payload);
  const bodyB64 = Buffer.from(body).toString("base64url");
  const sig = createHmac("sha256", SECRET!).update(bodyB64).digest("base64url");
  return `${bodyB64}.${sig}`;
}

export type VerifyResult =
  | { valid: true; orgId: string }
  | { valid: false; reason: string };

export async function verifyOrgContext(
  token: string | null | undefined
): Promise<VerifyResult> {
  if (!token) return { valid: false, reason: "no_token" };

  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [bodyB64, sig] = parts;
  if (!bodyB64 || !sig) return { valid: false, reason: "malformed" };

  const expected = createHmac("sha256", SECRET!)
    .update(bodyB64)
    .digest("base64url");
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length) {
    return { valid: false, reason: "sig_len_mismatch" };
  }
  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "sig_mismatch" };
  }

  let payload: { orgId?: string; timestamp?: number; nonce?: string };
  try {
    payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString());
  } catch {
    return { valid: false, reason: "payload_parse_error" };
  }

  if (typeof payload.timestamp !== "number") {
    return { valid: false, reason: "no_timestamp" };
  }
  if (Date.now() - payload.timestamp > TOKEN_TTL_MS) {
    return { valid: false, reason: "expired" };
  }
  if (typeof payload.orgId !== "string" || !payload.orgId) {
    return { valid: false, reason: "no_orgid" };
  }

  return { valid: true, orgId: payload.orgId };
}
