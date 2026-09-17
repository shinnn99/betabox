import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_INSTANCE_LEASE_MS,
  decideAgentInstance,
  leaseExpiredBefore,
} from "../src/lib/warehouse/agent-instance-lease.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = new Date("2026-09-17T10:00:00.000Z");
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

test("first new agent with no holder claims the lease", () => {
  assert.deepEqual(
    decideAgentInstance({ instanceId: A, activeInstanceId: null, activeSeenAt: null, now }),
    { kind: "claim" },
  );
});

test("the holder keeps getting commands", () => {
  assert.deepEqual(
    decideAgentInstance({ instanceId: A, activeInstanceId: A, activeSeenAt: secondsAgo(3), now }),
    { kind: "owner" },
  );
});

test("a second machine with the same agent code is refused while the lease is live", () => {
  assert.deepEqual(
    decideAgentInstance({ instanceId: B, activeInstanceId: A, activeSeenAt: secondsAgo(3), now }),
    { kind: "conflict", activeInstanceId: A },
  );
});

test("a machine that died stops blocking once the lease expires", () => {
  assert.deepEqual(
    decideAgentInstance({
      instanceId: B,
      activeInstanceId: A,
      activeSeenAt: secondsAgo(AGENT_INSTANCE_LEASE_MS / 1000 + 1),
      now,
    }),
    { kind: "claim" },
  );
});

// Ca thật 17/09/2026: bản agent cũ (không gửi mã phiên) giành lệnh của bản mới.
test("an old agent gets no commands while a new agent holds the lease", () => {
  assert.deepEqual(
    decideAgentInstance({ instanceId: null, activeInstanceId: A, activeSeenAt: secondsAgo(3), now }),
    { kind: "legacy_blocked", activeInstanceId: A },
  );
});

test("warehouses running only old agents are unaffected", () => {
  assert.deepEqual(
    decideAgentInstance({ instanceId: null, activeInstanceId: null, activeSeenAt: null, now }),
    { kind: "legacy_allowed" },
  );
  assert.deepEqual(
    decideAgentInstance({ instanceId: null, activeInstanceId: A, activeSeenAt: secondsAgo(600), now }),
    { kind: "legacy_allowed" },
  );
});

test("lease cutoff is exactly lease length before now", () => {
  assert.equal(leaseExpiredBefore(now), secondsAgo(AGENT_INSTANCE_LEASE_MS / 1000));
});
