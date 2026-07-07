import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AgentApiPath } from "./agent-api-paths";

/**
 * Agent v0.4 ký toàn bộ request bằng HMAC v2. Canonical:
 *   `v2\n${agentCode}\n${method}\n${canonicalPath}\n${bodySha256Hex}\n${timestamp}\n${nonce}`
 *
 * Backend `src/lib/warehouse/agent-auth-core.ts::canonicalV2` phải giữ
 * đồng bộ. Test `tests/agent-api-paths-mirror.test.ts` chốt bên map paths.
 *
 * Nonce format: URL-safe 22 chars (16 bytes base64url). Backend regex
 * NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/ — 22 chars pass.
 *
 * Retry KHÔNG re-use nonce cũ. Caller PHẢI gọi lại `signBodyV2` mỗi
 * attempt để sinh nonce mới; retry với header cũ bị backend reject
 * (replay).
 */

export type SignedHeaders = Record<string, string> & {
  "content-type": "application/json";
};

export function signBodyV2(params: {
  agentCode: string;
  agentSecret: string;
  method: "POST";
  canonicalPath: AgentApiPath;
  body: string;
  now?: number;
}): SignedHeaders {
  const timestamp = String(params.now ?? Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(params.body, "utf8").digest("hex");
  const message = [
    "v2",
    params.agentCode,
    params.method.toUpperCase(),
    params.canonicalPath,
    bodyHash,
    timestamp,
    nonce,
  ].join("\n");
  const signature = createHmac("sha256", params.agentSecret)
    .update(message)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-agent-code": params.agentCode,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": signature,
    "x-agent-sig-version": "v2",
    "x-agent-nonce": nonce,
  };
}
