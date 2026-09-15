import { test } from "node:test";
import assert from "node:assert/strict";
import { planQrCameraForProofClip } from "../src/lib/agent-commands/cut-clip-planning.ts";

test("proof clip uses immutable QR camera snapshot when present", () => {
  const plan = planQrCameraForProofClip({
    snapshotCameraId: "11111111-1111-4111-8111-111111111111",
    stationId: "22222222-2222-4222-8222-222222222222",
  });

  assert.deepEqual(plan, {
    cameraId: "11111111-1111-4111-8111-111111111111",
    shouldResolveStationAssignment: false,
  });
});

test("proof clip still resolves assigned QR camera when no snapshot exists", () => {
  const plan = planQrCameraForProofClip({
    snapshotCameraId: null,
    stationId: "22222222-2222-4222-8222-222222222222",
  });

  assert.deepEqual(plan, {
    cameraId: null,
    shouldResolveStationAssignment: true,
  });
});

test("proof clip does not try station fallback without a station", () => {
  const plan = planQrCameraForProofClip({
    snapshotCameraId: null,
    stationId: null,
  });

  assert.deepEqual(plan, {
    cameraId: null,
    shouldResolveStationAssignment: false,
  });
});
