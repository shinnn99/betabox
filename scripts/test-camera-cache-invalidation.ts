/* eslint-disable @typescript-eslint/no-explicit-any */
// Contract test for the camera service cache + invalidation.
// Verifies:
//   1. loadCameraStationMap caches per-org within TTL (second call hits cache).
//   2. invalidateCameraCaches(org) drops both stationMap AND softLinksDoneAt
//      so the next list rebuilds — without waiting for TTL.
//   3. The cache is scoped per organization: invalidating org A leaves
//      org B's cache intact.
//   4. ensureCameraSoftLinks short-circuits within TTL.
//
// Run from repo root (BC_TEST_STUB_ADMIN=1 makes the loader swap the
// Supabase admin client for a counting mock — no DB hits):
//   BC_TEST_STUB_ADMIN=1 node --import "data:text/javascript,\
//   import{register}from'node:module';import{pathToFileURL}from'node:url';\
//   register('./scripts/node-path-alias-loader.mjs',pathToFileURL('./'));"\
//   scripts/test-camera-cache-invalidation.ts

import {
  ensureCameraSoftLinks,
  invalidateCameraCaches,
  listCameras,
} from "../src/lib/camera/service.ts";

const g = globalThis as any;

function cameraReads(): number {
  return g.__bc_camera_select_calls__ ?? 0;
}
function stationDeviceReads(): number {
  return g.__bc_station_device_select_calls__ ?? 0;
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

async function main(): Promise<void> {
  if (process.env.BC_TEST_STUB_ADMIN !== "1") {
    console.error(
      "FATAL: BC_TEST_STUB_ADMIN=1 not set. This test must not touch real DB.",
    );
    process.exit(1);
  }

  const orgA = "11111111-1111-1111-1111-111111111111";
  const orgB = "22222222-2222-2222-2222-222222222222";

  // --- Test 1: first listCameras for orgA triggers DB; second hits cache.
  await listCameras(orgA);
  const sdAfterFirst = stationDeviceReads();
  assert(cameraReads() >= 1, "first listCameras reads cameras table");
  assert(sdAfterFirst >= 1, "first listCameras reads station_devices");

  await listCameras(orgA);
  assert(
    stationDeviceReads() === sdAfterFirst,
    `second listCameras within TTL: station_devices reads unchanged ` +
      `(was ${sdAfterFirst}, now ${stationDeviceReads()})`,
  );

  // --- Test 2: invalidate orgA. Next listCameras for orgA must re-read.
  invalidateCameraCaches(orgA);
  await listCameras(orgA);
  assert(
    stationDeviceReads() > sdAfterFirst,
    `after invalidate, listCameras re-reads station_devices ` +
      `(was ${sdAfterFirst}, now ${stationDeviceReads()})`,
  );

  // --- Test 3: per-org isolation.
  const sdBeforeOrgB = stationDeviceReads();
  await listCameras(orgB);
  const sdAfterOrgB = stationDeviceReads();
  assert(
    sdAfterOrgB > sdBeforeOrgB,
    "first listCameras for orgB reads station_devices (separate cache key)",
  );

  // Invalidate orgA only — orgB cache should remain.
  invalidateCameraCaches(orgA);
  const sdBeforeOrgBSecond = stationDeviceReads();
  await listCameras(orgB);
  assert(
    stationDeviceReads() === sdBeforeOrgBSecond,
    `invalidate(orgA) did NOT clear orgB cache ` +
      `(orgB reads stayed at ${sdBeforeOrgBSecond})`,
  );

  // --- Test 4: ensureCameraSoftLinks marks the cache when it runs the
  // SELECT pass; a second call within TTL short-circuits.
  // Reset by invalidating then call with a non-empty camera list so the
  // function actually reaches the cache-mark line.
  invalidateCameraCaches(orgB);
  const sdBeforeEnsureFirst = stationDeviceReads();
  await ensureCameraSoftLinks(orgB, [
    { id: "33333333-3333-3333-3333-333333333333", camera_code: "CAM_X", name: "X" },
  ]);
  const sdAfterEnsureFirst = stationDeviceReads();
  assert(
    sdAfterEnsureFirst > sdBeforeEnsureFirst,
    "first ensureCameraSoftLinks reads station_devices (cache empty)",
  );

  await ensureCameraSoftLinks(orgB, [
    { id: "33333333-3333-3333-3333-333333333333", camera_code: "CAM_X", name: "X" },
  ]);
  assert(
    stationDeviceReads() === sdAfterEnsureFirst,
    "second ensureCameraSoftLinks within TTL short-circuits (no new reads)",
  );

  // --- Test 5: invalidate then ensure should re-read.
  invalidateCameraCaches(orgB);
  const sdBeforeEnsureAfterInvalidate = stationDeviceReads();
  await ensureCameraSoftLinks(orgB, [
    { id: "33333333-3333-3333-3333-333333333333", camera_code: "CAM_X", name: "X" },
  ]);
  assert(
    stationDeviceReads() > sdBeforeEnsureAfterInvalidate,
    "ensureCameraSoftLinks re-reads after invalidateCameraCaches",
  );

  console.log("\nALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
