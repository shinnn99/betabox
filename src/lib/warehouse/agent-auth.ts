import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeNonceExpiresAt,
  parseTimestampMs,
  readAgentHeadersFromRecord,
  verifySignatureV1,
  verifySignatureV2,
  type AgentAuthFailure,
  type AgentAuthHeaders,
  type AgentAuthHeadersV1,
  type AgentAuthHeadersV2,
  type AgentAuthSuccess,
} from "./agent-auth-core";

export type {
  AgentAuthHeaders,
  AgentAuthFailure,
  AgentAuthSuccess,
  SignatureVersion,
} from "./agent-auth-core";

/**
 * Backward-compat re-export cho callers cũ.
 */
export function readAgentHeaders(req: Request): AgentAuthHeaders | null {
  return readAgentHeadersFromRecord((name) => req.headers.get(name));
}

/**
 * Verify signature LEGACY V1 (không consume nonce). Backward-compat cho
 * route đã tồn tại — callers hiện tại pass v1 headers.
 *
 * B1.3: hàm này giữ signature cũ để không break callers. Route mới nên
 * dùng `verifyAgentRequest` dưới đây (hỗ trợ cả v1 + v2).
 */
export function verifyAgentSignature(params: {
  rawBody: string;
  headers: { code: string; timestamp: string; signature: string };
  secret: string;
  now?: number;
}): AgentAuthSuccess | AgentAuthFailure {
  const v1Headers: AgentAuthHeadersV1 = {
    version: "v1",
    code: params.headers.code,
    timestamp: params.headers.timestamp,
    signature: params.headers.signature,
  };
  return verifySignatureV1({
    rawBody: params.rawBody,
    headers: v1Headers,
    secret: params.secret,
    now: params.now,
  });
}

/**
 * B1.3 nonce consumer: atomic INSERT với ON CONFLICT DO NOTHING. Trả
 * true nếu nonce mới (consume OK), false nếu duplicate (replay).
 *
 * KHÔNG throw nếu DB error — caller phải xử. Fail-closed: DB error =
 * treat as replay để không lỡ cho request qua khi nonce store hỏng.
 *
 * Consumer tách riêng để test được (inject mock client).
 */
export interface NonceConsumeResult {
  ok: boolean;
  reason?: "duplicate" | "db_error";
  errorMessage?: string;
}

export async function consumeNonce(
  admin: SupabaseClient,
  params: {
    agentId: string;
    nonce: string;
    requestTimestampMs: number;
  },
): Promise<NonceConsumeResult> {
  const expiresAt = computeNonceExpiresAt(params.requestTimestampMs);
  const { data, error, status } = await admin
    .from("warehouse_agent_request_nonces")
    .insert({
      agent_id: params.agentId,
      nonce: params.nonce,
      request_timestamp: new Date(params.requestTimestampMs).toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select("agent_id")
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation → duplicate = replay
    if (error.code === "23505") {
      return { ok: false, reason: "duplicate" };
    }
    // Fail-closed: DB error khác coi như reject để không cho request qua
    // khi nonce store hỏng. Log để ops thấy.
    console.error(
      `[nonce] consume failed agent=${params.agentId} code=${error.code ?? "?"} message=${error.message}`,
    );
    return { ok: false, reason: "db_error", errorMessage: error.message };
  }

  // maybeSingle trả null nếu 0 row — không nên xảy ra sau INSERT OK, nhưng
  // guard defensive.
  if (!data && status !== 201 && status !== 200) {
    console.error(
      `[nonce] consume unexpected empty response agent=${params.agentId} status=${status}`,
    );
    return { ok: false, reason: "db_error", errorMessage: "empty_response" };
  }

  return { ok: true };
}

/**
 * B1.3 orchestrator: verify signature (v1 hoặc v2) + consume nonce nếu v2.
 * B1.4 (Lát B): sau signature verify, check per-agent `hmac_v2_enforced_at`.
 *   Nếu agent đã enforce v2 và request là v1 → reject 401. Order matter:
 *   signature verify TRƯỚC enforcement check → không dùng endpoint làm
 *   oracle dò agent code (attacker gửi request v1 với code hợp lệ nhưng
 *   secret sai → vẫn bị reject signature verify trước; check version chỉ
 *   ăn khi signature đã đúng nghĩa là agent thật, không leak info).
 */
export async function verifyAgentRequest(
  admin: SupabaseClient,
  params: {
    rawBody: string;
    method: string;
    canonicalPath: string;
    headers: AgentAuthHeaders;
    agentId: string;
    secret: string;
    /**
     * B1.4: nullable timestamp per-agent. Nếu <= now() và request v1 →
     * reject. Route caller đọc column từ warehouse_agents rồi truyền vào.
     */
    hmacV2EnforcedAt?: string | null;
    now?: number;
  },
): Promise<AgentAuthSuccess | AgentAuthFailure> {
  // Step 1: verify signature (không đụng DB).
  let sigResult: AgentAuthSuccess | AgentAuthFailure;
  if (params.headers.version === "v1") {
    sigResult = verifySignatureV1({
      rawBody: params.rawBody,
      headers: params.headers,
      secret: params.secret,
      now: params.now,
    });
  } else {
    sigResult = verifySignatureV2({
      rawBody: params.rawBody,
      method: params.method,
      canonicalPath: params.canonicalPath,
      headers: params.headers as AgentAuthHeadersV2,
      secret: params.secret,
      now: params.now,
    });
  }

  if (!sigResult.ok) return sigResult;

  // Step 2 (B1.4): per-agent v2 enforcement. Đặt SAU signature verify để
  // không leak "code này có tồn tại và enforce_at không" cho attacker
  // không có secret. Response error là 401 chung — log riêng ở caller.
  if (params.hmacV2EnforcedAt) {
    const enforceMs = Date.parse(params.hmacV2EnforcedAt);
    const nowMs = params.now ?? Date.now();
    if (
      Number.isFinite(enforceMs) &&
      enforceMs <= nowMs &&
      sigResult.version === "v1"
    ) {
      console.warn(
        `[agent-auth] v2 enforced agent=${params.agentId} route=${params.canonicalPath} received=v1`,
      );
      return { ok: false, status: 401, error: "bad_signature" };
    }
  }

  // Step 3: consume nonce (chỉ v2). Signature invalid không consume →
  // chống DoS bảng nonce.
  if (params.headers.version === "v2") {
    const nonceHeaders = params.headers as AgentAuthHeadersV2;
    const tsMs = parseTimestampMs(nonceHeaders.timestamp);
    if (tsMs === null) {
      // Guard defensive — verifySignatureV2 đã check ts nhưng repeat để type-safe.
      return { ok: false, status: 400, error: "bad_timestamp" };
    }
    const consume = await consumeNonce(admin, {
      agentId: params.agentId,
      nonce: nonceHeaders.nonce,
      requestTimestampMs: tsMs,
    });
    if (!consume.ok) {
      if (consume.reason === "duplicate") {
        return { ok: false, status: 401, error: "replay_rejected" };
      }
      // db_error → fail-closed 401 (đã log).
      return { ok: false, status: 401, error: "replay_rejected" };
    }
  }

  return sigResult;
}
