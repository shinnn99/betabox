import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  canonicalV1,
  canonicalV2,
  bodySha256Hex,
  computeNonceExpiresAt,
  parseTimestampMs,
  readAgentHeadersFromRecord,
  validateNonce,
  verifySignatureV1,
  verifySignatureV2,
  MAX_CLOCK_SKEW_MS,
  NONCE_SAFETY_BUFFER_MS,
  type AgentAuthHeadersV1,
  type AgentAuthHeadersV2,
} from "../src/lib/warehouse/agent-auth-core";

const SECRET = "test_secret_16_bytes_min";
const NOW = 1_800_000_000_000; // 2027-01-15

function signV1(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret)
    .update(canonicalV1(timestamp, body))
    .digest("hex");
}

function signV2(
  secret: string,
  params: {
    code: string;
    method: string;
    canonicalPath: string;
    timestamp: string;
    nonce: string;
    body: string;
  },
): string {
  const msg = canonicalV2({
    code: params.code,
    method: params.method,
    canonicalPath: params.canonicalPath,
    bodySha256Hex: bodySha256Hex(params.body),
    timestamp: params.timestamp,
    nonce: params.nonce,
  });
  return createHmac("sha256", secret).update(msg).digest("hex");
}

// ============================================================================
// readAgentHeadersFromRecord
// ============================================================================

test("readAgentHeadersFromRecord: v1 default khi không có x-agent-sig-version", () => {
  const store = new Map([
    ["x-agent-code", "AGENT_A"],
    ["x-agent-timestamp", String(NOW)],
    ["x-agent-signature", "abc"],
  ]);
  const h = readAgentHeadersFromRecord((n) => store.get(n) ?? null);
  assert.ok(h);
  assert.equal(h?.version, "v1");
});

test("readAgentHeadersFromRecord: v2 khi x-agent-sig-version=v2 + nonce present", () => {
  const store = new Map([
    ["x-agent-code", "AGENT_A"],
    ["x-agent-timestamp", String(NOW)],
    ["x-agent-signature", "abc"],
    ["x-agent-sig-version", "v2"],
    ["x-agent-nonce", "nonce_abc_123"],
  ]);
  const h = readAgentHeadersFromRecord((n) => store.get(n) ?? null);
  assert.equal(h?.version, "v2");
  if (h?.version === "v2") assert.equal(h.nonce, "nonce_abc_123");
});

test("readAgentHeadersFromRecord: v2 thiếu nonce → null", () => {
  const store = new Map([
    ["x-agent-code", "AGENT_A"],
    ["x-agent-timestamp", String(NOW)],
    ["x-agent-signature", "abc"],
    ["x-agent-sig-version", "v2"],
  ]);
  const h = readAgentHeadersFromRecord((n) => store.get(n) ?? null);
  assert.equal(h, null);
});

test("readAgentHeadersFromRecord: thiếu code/timestamp/signature → null", () => {
  const store = new Map([["x-agent-code", "AGENT_A"]]);
  const h = readAgentHeadersFromRecord((n) => store.get(n) ?? null);
  assert.equal(h, null);
});

// ============================================================================
// validateNonce
// ============================================================================

test("validateNonce: length 8-128 URL-safe chars", () => {
  assert.equal(validateNonce("abc12345"), true); // 8 chars OK
  assert.equal(validateNonce("a".repeat(128)), true); // 128 chars OK
  assert.equal(validateNonce("abc-def_ghi"), true); // dash + underscore OK
});

test("validateNonce: reject quá ngắn", () => {
  assert.equal(validateNonce("short"), false); // 5 chars
});

test("validateNonce: reject quá dài", () => {
  assert.equal(validateNonce("a".repeat(129)), false);
});

test("validateNonce: reject ký tự lạ", () => {
  assert.equal(validateNonce("abc def123"), false); // space
  assert.equal(validateNonce("abc$def123"), false); // $
  assert.equal(validateNonce("abc.def123"), false); // dot
});

// ============================================================================
// canonicalV1 / canonicalV2 / bodySha256Hex
// ============================================================================

test("canonicalV1: timestamp.body", () => {
  assert.equal(canonicalV1("12345", '{"k":"v"}'), '12345.{"k":"v"}');
});

test("canonicalV2: 7 line format", () => {
  const c = canonicalV2({
    code: "AGENT_A",
    method: "POST",
    canonicalPath: "/api/warehouse/heartbeat",
    bodySha256Hex: "abc123",
    timestamp: "12345",
    nonce: "nonce_x",
  });
  assert.equal(
    c,
    "v2\nAGENT_A\nPOST\n/api/warehouse/heartbeat\nabc123\n12345\nnonce_x",
  );
});

test("canonicalV2: method uppercase", () => {
  const c = canonicalV2({
    code: "A",
    method: "post",
    canonicalPath: "/x",
    bodySha256Hex: "h",
    timestamp: "1",
    nonce: "n_1234567",
  });
  assert.match(c, /\nPOST\n/);
});

test("canonicalV2: body hash lowercase", () => {
  const c = canonicalV2({
    code: "A",
    method: "POST",
    canonicalPath: "/x",
    bodySha256Hex: "ABCDEF",
    timestamp: "1",
    nonce: "n_1234567",
  });
  assert.match(c, /\nabcdef\n/);
});

test("bodySha256Hex: deterministic + đúng SHA-256", () => {
  const h = bodySha256Hex("hello");
  const expected = createHash("sha256").update("hello").digest("hex");
  assert.equal(h, expected);
});

// ============================================================================
// verifySignatureV1
// ============================================================================

test("verifySignatureV1: happy path", () => {
  const body = '{"ping":true}';
  const ts = String(NOW);
  const sig = signV1(SECRET, ts, body);
  const headers: AgentAuthHeadersV1 = {
    version: "v1",
    code: "AGENT_A",
    timestamp: ts,
    signature: sig,
  };
  const r = verifySignatureV1({ rawBody: body, headers, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.version, "v1");
});

test("verifySignatureV1: timestamp skew > 5 phút → timestamp_skew", () => {
  const body = "";
  const ts = String(NOW - 10 * 60 * 1000);
  const sig = signV1(SECRET, ts, body);
  const headers: AgentAuthHeadersV1 = {
    version: "v1",
    code: "A",
    timestamp: ts,
    signature: sig,
  };
  const r = verifySignatureV1({ rawBody: body, headers, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "timestamp_skew");
});

test("verifySignatureV1: signature sai → bad_signature", () => {
  const body = "";
  const ts = String(NOW);
  const headers: AgentAuthHeadersV1 = {
    version: "v1",
    code: "A",
    timestamp: ts,
    signature: "deadbeef".repeat(8),
  };
  const r = verifySignatureV1({ rawBody: body, headers, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "bad_signature");
});

// ============================================================================
// verifySignatureV2
// ============================================================================

test("verifySignatureV2: happy path", () => {
  const body = '{"ping":true}';
  const ts = String(NOW);
  const nonce = "nonce_abc_12345";
  const sig = signV2(SECRET, {
    code: "AGENT_A",
    method: "POST",
    canonicalPath: "/api/warehouse/heartbeat",
    timestamp: ts,
    nonce,
    body,
  });
  const headers: AgentAuthHeadersV2 = {
    version: "v2",
    code: "AGENT_A",
    timestamp: ts,
    signature: sig,
    nonce,
  };
  const r = verifySignatureV2({
    rawBody: body,
    method: "POST",
    canonicalPath: "/api/warehouse/heartbeat",
    headers,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.version, "v2");
});

test("verifySignatureV2: body khác → bad_signature", () => {
  const body = '{"ping":true}';
  const ts = String(NOW);
  const nonce = "nonce_abc_12345";
  const sig = signV2(SECRET, {
    code: "AGENT_A",
    method: "POST",
    canonicalPath: "/x",
    timestamp: ts,
    nonce,
    body,
  });
  const headers: AgentAuthHeadersV2 = {
    version: "v2",
    code: "AGENT_A",
    timestamp: ts,
    signature: sig,
    nonce,
  };
  const r = verifySignatureV2({
    rawBody: '{"ping":false}', // tampered
    method: "POST",
    canonicalPath: "/x",
    headers,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "bad_signature");
});

test("verifySignatureV2: method khác → bad_signature", () => {
  const body = "";
  const ts = String(NOW);
  const nonce = "nonce_abc_12345";
  const sig = signV2(SECRET, {
    code: "A",
    method: "POST",
    canonicalPath: "/x",
    timestamp: ts,
    nonce,
    body,
  });
  const headers: AgentAuthHeadersV2 = {
    version: "v2",
    code: "A",
    timestamp: ts,
    signature: sig,
    nonce,
  };
  const r = verifySignatureV2({
    rawBody: body,
    method: "PUT",
    canonicalPath: "/x",
    headers,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "bad_signature");
});

test("verifySignatureV2: path khác → bad_signature", () => {
  const body = "";
  const ts = String(NOW);
  const nonce = "nonce_abc_12345";
  const sig = signV2(SECRET, {
    code: "A",
    method: "POST",
    canonicalPath: "/x",
    timestamp: ts,
    nonce,
    body,
  });
  const headers: AgentAuthHeadersV2 = {
    version: "v2",
    code: "A",
    timestamp: ts,
    signature: sig,
    nonce,
  };
  const r = verifySignatureV2({
    rawBody: body,
    method: "POST",
    canonicalPath: "/y",
    headers,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "bad_signature");
});

test("verifySignatureV2: nonce malformed → bad_nonce (không phải bad_signature)", () => {
  const body = "";
  const ts = String(NOW);
  const nonce = "short"; // < 8 chars
  const headers: AgentAuthHeadersV2 = {
    version: "v2",
    code: "A",
    timestamp: ts,
    signature: "a".repeat(64),
    nonce,
  };
  const r = verifySignatureV2({
    rawBody: body,
    method: "POST",
    canonicalPath: "/x",
    headers,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "bad_nonce");
});

test("verifySignatureV2: timestamp future > 5 phút → timestamp_skew", () => {
  const body = "";
  const futureTs = String(NOW + 10 * 60 * 1000);
  const nonce = "nonce_abc_12345";
  const sig = signV2(SECRET, {
    code: "A",
    method: "POST",
    canonicalPath: "/x",
    timestamp: futureTs,
    nonce,
    body,
  });
  const headers: AgentAuthHeadersV2 = {
    version: "v2",
    code: "A",
    timestamp: futureTs,
    signature: sig,
    nonce,
  };
  const r = verifySignatureV2({
    rawBody: body,
    method: "POST",
    canonicalPath: "/x",
    headers,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "timestamp_skew");
});

// ============================================================================
// computeNonceExpiresAt
// ============================================================================

test("computeNonceExpiresAt: = ts + MAX_SKEW + BUFFER", () => {
  const ts = 1_000_000;
  const exp = computeNonceExpiresAt(ts);
  const expected = new Date(ts + MAX_CLOCK_SKEW_MS + NONCE_SAFETY_BUFFER_MS);
  assert.equal(exp.getTime(), expected.getTime());
});

// ============================================================================
// parseTimestampMs
// ============================================================================

test("parseTimestampMs: epoch ms number string", () => {
  assert.equal(parseTimestampMs("1800000000000"), 1_800_000_000_000);
});

test("parseTimestampMs: ISO string", () => {
  assert.equal(parseTimestampMs("2027-01-15T00:00:00Z"), Date.UTC(2027, 0, 15));
});

test("parseTimestampMs: invalid → null", () => {
  assert.equal(parseTimestampMs("garbage"), null);
});
