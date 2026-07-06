import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BC_TEST_STUB_ADMIN = "1";

const mod = await import("../src/lib/warehouse/agent-auth");
const telemetry = await import("../src/lib/warehouse/agent-sig-telemetry");

/**
 * Test consumeNonce + verifyAgentRequest với mock Supabase client.
 *
 * Mock trả:
 *   - null error, data không rỗng → nonce mới, consume OK.
 *   - error.code = '23505' → duplicate = replay.
 *   - error.code khác → db_error → fail-closed.
 */

interface MockCall {
  table: string;
  action: string;
  row?: Record<string, unknown>;
}

function makeAdminMock(
  behavior:
    | { type: "ok" }
    | { type: "dup" }
    | { type: "db_error"; code: string; message: string },
) {
  const calls: MockCall[] = [];
  const client = {
    from(table: string) {
      calls.push({ table, action: "from" });
      return {
        insert(row: Record<string, unknown>) {
          calls.push({ table, action: "insert", row });
          return {
            select(_cols: string) {
              return {
                async maybeSingle() {
                  if (behavior.type === "ok") {
                    return {
                      data: { agent_id: row.agent_id },
                      error: null,
                      status: 201,
                    };
                  }
                  if (behavior.type === "dup") {
                    return {
                      data: null,
                      error: { code: "23505", message: "unique_violation" },
                      status: 409,
                    };
                  }
                  return {
                    data: null,
                    error: {
                      code: behavior.code,
                      message: behavior.message,
                    },
                    status: 500,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

test("consumeNonce: first insert OK → { ok: true }", async () => {
  const { client } = makeAdminMock({ type: "ok" });
  const r = await mod.consumeNonce(client as unknown as never, {
    agentId: "agent-1",
    nonce: "nonce_abc_1234",
    requestTimestampMs: Date.now(),
  });
  assert.equal(r.ok, true);
});

test("consumeNonce: duplicate 23505 → { ok: false, reason: 'duplicate' }", async () => {
  const { client } = makeAdminMock({ type: "dup" });
  const r = await mod.consumeNonce(client as unknown as never, {
    agentId: "agent-1",
    nonce: "nonce_abc_1234",
    requestTimestampMs: Date.now(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate");
});

test("consumeNonce: db_error → { ok: false, reason: 'db_error' } fail-closed", async () => {
  const { client } = makeAdminMock({
    type: "db_error",
    code: "40001",
    message: "serialization_failure",
  });
  const logs: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => logs.push(String(msg));
  try {
    const r = await mod.consumeNonce(client as unknown as never, {
      agentId: "agent-1",
      nonce: "nonce_abc_1234",
      requestTimestampMs: Date.now(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "db_error");
    assert.match(logs.join("\n"), /\[nonce\] consume failed/);
    assert.match(logs.join("\n"), /40001/);
  } finally {
    console.error = orig;
  }
});

// ============================================================================
// verifyAgentRequest orchestrator
// ============================================================================

import { createHmac } from "node:crypto";
import {
  canonicalV2,
  bodySha256Hex,
} from "../src/lib/warehouse/agent-auth-core";

const SECRET = "test_secret_16_bytes_min";
const NOW = 1_800_000_000_000;

function signV2(params: {
  code: string;
  method: string;
  canonicalPath: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  const msg = canonicalV2({
    code: params.code,
    method: params.method,
    canonicalPath: params.canonicalPath,
    bodySha256Hex: bodySha256Hex(params.body),
    timestamp: params.timestamp,
    nonce: params.nonce,
  });
  return createHmac("sha256", SECRET).update(msg).digest("hex");
}

test("verifyAgentRequest v2: happy path — signature OK + nonce first-time → { ok: true, version: 'v2' }", async () => {
  const body = '{"ping":true}';
  const ts = String(NOW);
  const nonce = "nonce_abc_first";
  const sig = signV2({
    code: "AGENT_A",
    method: "POST",
    canonicalPath: "/api/warehouse/heartbeat",
    timestamp: ts,
    nonce,
    body,
  });
  const { client } = makeAdminMock({ type: "ok" });
  const r = await mod.verifyAgentRequest(client as unknown as never, {
    rawBody: body,
    method: "POST",
    canonicalPath: "/api/warehouse/heartbeat",
    headers: {
      version: "v2",
      code: "AGENT_A",
      timestamp: ts,
      signature: sig,
      nonce,
    },
    agentId: "agent-1",
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.version, "v2");
});

test("verifyAgentRequest v2: replay — signature OK + nonce duplicate → 401 replay_rejected", async () => {
  const body = "";
  const ts = String(NOW);
  const nonce = "nonce_abc_dup";
  const sig = signV2({
    code: "A",
    method: "POST",
    canonicalPath: "/x",
    timestamp: ts,
    nonce,
    body,
  });
  const { client } = makeAdminMock({ type: "dup" });
  const r = await mod.verifyAgentRequest(client as unknown as never, {
    rawBody: body,
    method: "POST",
    canonicalPath: "/x",
    headers: {
      version: "v2",
      code: "A",
      timestamp: ts,
      signature: sig,
      nonce,
    },
    agentId: "agent-1",
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, "replay_rejected");
    assert.equal(r.status, 401);
  }
});

test("verifyAgentRequest v2: signature invalid → KHÔNG consume nonce", async () => {
  const body = "";
  const ts = String(NOW);
  const nonce = "nonce_abc_never_used";
  const { client, calls } = makeAdminMock({ type: "ok" });
  const r = await mod.verifyAgentRequest(client as unknown as never, {
    rawBody: body,
    method: "POST",
    canonicalPath: "/x",
    headers: {
      version: "v2",
      code: "A",
      timestamp: ts,
      signature: "deadbeef".repeat(8),
      nonce,
    },
    agentId: "agent-1",
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "bad_signature");
  // Verify KHÔNG có call insert nào (nonce không bị consume).
  const insertCalls = calls.filter((c) => c.action === "insert");
  assert.equal(
    insertCalls.length,
    0,
    "nonce KHÔNG được consume khi signature invalid",
  );
});

test("verifyAgentRequest v2: db_error → 401 replay_rejected (fail-closed)", async () => {
  const body = "";
  const ts = String(NOW);
  const nonce = "nonce_abc_dberr";
  const sig = signV2({
    code: "A",
    method: "POST",
    canonicalPath: "/x",
    timestamp: ts,
    nonce,
    body,
  });
  const { client } = makeAdminMock({
    type: "db_error",
    code: "40001",
    message: "serialization_failure",
  });
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await mod.verifyAgentRequest(client as unknown as never, {
      rawBody: body,
      method: "POST",
      canonicalPath: "/x",
      headers: {
        version: "v2",
        code: "A",
        timestamp: ts,
        signature: sig,
        nonce,
      },
      agentId: "agent-1",
      secret: SECRET,
      now: NOW,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "replay_rejected");
      assert.equal(r.status, 401);
    }
  } finally {
    console.error = orig;
  }
});

test("verifyAgentRequest v1 legacy: KHÔNG consume nonce (chỉ verify signature)", async () => {
  const body = '{"ping":true}';
  const ts = String(NOW);
  const sig = createHmac("sha256", SECRET)
    .update(`${ts}.${body}`)
    .digest("hex");
  const { client, calls } = makeAdminMock({ type: "ok" });
  const r = await mod.verifyAgentRequest(client as unknown as never, {
    rawBody: body,
    method: "POST",
    canonicalPath: "/api/warehouse/heartbeat",
    headers: {
      version: "v1",
      code: "AGENT_A",
      timestamp: ts,
      signature: sig,
    },
    agentId: "agent-1",
    secret: SECRET,
    now: NOW,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.version, "v1");
  const insertCalls = calls.filter((c) => c.action === "insert");
  assert.equal(insertCalls.length, 0, "v1 legacy: 0 nonce insert");
});

// ============================================================================
// Telemetry counter
// ============================================================================

test("recordAgentSigVersion: đếm v1 vs v2 per agent trong cycle", () => {
  telemetry._debugReset();
  telemetry.recordAgentSigVersion("agent-1", "v1");
  telemetry.recordAgentSigVersion("agent-1", "v1");
  telemetry.recordAgentSigVersion("agent-1", "v2");
  telemetry.recordAgentSigVersion("agent-2", "v2");
  const state = telemetry._debugCycleState();
  const a1 = state.byVersionByAgent.get("agent-1");
  const a2 = state.byVersionByAgent.get("agent-2");
  assert.deepEqual(a1, { v1: 2, v2: 1 });
  assert.deepEqual(a2, { v1: 0, v2: 1 });
});
