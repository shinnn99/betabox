import { test } from "node:test";
import assert from "node:assert/strict";
import { isSeparateQrAngle, planQrCameraForProofClip } from "../src/lib/agent-commands/cut-clip-planning.ts";

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

// Bàn chỉ có một camera: cả hai góc cùng camera → không ghép PiP với chính nó.
test("QR angle is skipped when it is the same camera as the overview", () => {
  const cam = "33333333-3333-4333-8333-333333333333";
  assert.equal(isSeparateQrAngle(cam, cam), false);
});

test("QR angle is used when it is a different camera", () => {
  assert.equal(
    isSeparateQrAngle(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ),
    true,
  );
});

test("QR angle is used when the overview camera is unknown", () => {
  assert.equal(isSeparateQrAngle(null, "44444444-4444-4444-8444-444444444444"), true);
});

test("no QR camera means no QR angle", () => {
  assert.equal(isSeparateQrAngle("33333333-3333-4333-8333-333333333333", null), false);
});
