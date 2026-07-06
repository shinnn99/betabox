import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveUiState } from "../src/lib/recording/ui-state";

/**
 * B2 CRIT-2: deriveUiState với connection_lost mapping.
 */

const NOW = 1_800_000_000_000;
const RECENT = new Date(NOW - 10_000).toISOString();
const STALE = new Date(NOW - 5 * 60 * 1000).toISOString();

test("deriveUiState: connection_lost → agent_disconnected (bất kể heartbeat)", () => {
  const r = deriveUiState({
    sessionStatus: "connection_lost",
    sessionHeartbeatAt: STALE,
    agentLastSeenAt: STALE,
    now: NOW,
  });
  assert.equal(r, "agent_disconnected");
});

test("deriveUiState: connection_lost với heartbeat tươi vẫn → agent_disconnected", () => {
  const r = deriveUiState({
    sessionStatus: "connection_lost",
    sessionHeartbeatAt: RECENT,
    agentLastSeenAt: RECENT,
    now: NOW,
  });
  assert.equal(r, "agent_disconnected");
});

test("deriveUiState: recording + heartbeat tươi + agent online → recording", () => {
  const r = deriveUiState({
    sessionStatus: "recording",
    sessionHeartbeatAt: RECENT,
    agentLastSeenAt: RECENT,
    now: NOW,
  });
  assert.equal(r, "recording");
});

test("deriveUiState: recording + heartbeat stale → agent_disconnected", () => {
  const r = deriveUiState({
    sessionStatus: "recording",
    sessionHeartbeatAt: STALE,
    agentLastSeenAt: RECENT,
    now: NOW,
  });
  assert.equal(r, "agent_disconnected");
});

test("deriveUiState: stopped → stopped", () => {
  const r = deriveUiState({
    sessionStatus: "stopped",
    sessionHeartbeatAt: null,
    agentLastSeenAt: null,
    now: NOW,
  });
  assert.equal(r, "stopped");
});

test("deriveUiState: error → error", () => {
  const r = deriveUiState({
    sessionStatus: "error",
    sessionHeartbeatAt: null,
    agentLastSeenAt: null,
    now: NOW,
  });
  assert.equal(r, "error");
});

test("deriveUiState: null session → unknown", () => {
  const r = deriveUiState({
    sessionStatus: null,
    sessionHeartbeatAt: null,
    agentLastSeenAt: null,
    now: NOW,
  });
  assert.equal(r, "unknown");
});
