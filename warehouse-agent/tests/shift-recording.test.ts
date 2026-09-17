import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialItem } from "../src/commands";
import { RecordingLifecycle, type LifecycleDeps } from "../src/recording-lifecycle";
import { camerasForShiftStart, isStaffQrShape, pickShiftCameras } from "../src/shift-recording";

const staffQr =
  "00000000-0000-0000-0000-000000000001.00000000-0000-0000-0000-000000000002.ABCDEFGHIJKLMNOP";

function camera(
  role: CredentialItem["role"],
  scanSource: CredentialItem["scan_source"],
): CredentialItem {
  return {
    camera_id: `${role}-${scanSource}`,
    camera_code: "cam_01",
    rtsp_url: "rtsp://camera/main",
    rtsp_substream_url: null,
    transport: "tcp",
    segment_seconds: 60,
    station_id: "station-1",
    role,
    scan_source: scanSource,
    scanner_device_code: role === "proof_qr" ? "qrcam_cam_01" : null,
    station_has_open_session: false,
  };
}

test("staff QR shape matches production token format without exposing token", () => {
  assert.equal(isStaffQrShape(staffQr), true);
  assert.equal(isStaffQrShape("SPXVN0123456789"), false);
  assert.equal(isStaffQrShape("STAFF_CHECKIN:legacy"), false);
});

test("scanner mode starts only overview camera", () => {
  const selected = camerasForShiftStart([
    camera("proof_primary", "scanner"),
    camera("proof_qr", "scanner"),
  ]);
  assert.deepEqual(selected.map((item) => item.role), ["proof_primary"]);
});

test("camera mode starts overview and QR cameras", () => {
  const selected = camerasForShiftStart([
    camera("proof_primary", "camera"),
    camera("proof_qr", "camera"),
  ]);
  assert.deepEqual(selected.map((item) => item.role), ["proof_primary", "proof_qr"]);
});

test("delayed stop can be cancelled when a new shift opens", async () => {
  const lifecycle = new RecordingLifecycle({} as LifecycleDeps);
  const outcome = await lifecycle.scheduleStop({
    cameraId: "camera-1",
    sessionId: "session-1",
    stopAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(outcome.scheduled, true);
  assert.equal(lifecycle.cancelScheduledStop("camera-1"), true);
  assert.equal(lifecycle.cancelScheduledStop("camera-1"), false);
});

// ---------------------------------------------------------------------------
// Một agent phục vụ nhiều bàn: quét QR nhân viên ở bàn nào chỉ bật ghi
// camera của bàn đó. Bật nhầm bàn là trộn bằng chứng của hai bàn.
// ---------------------------------------------------------------------------

function at(
  stationId: string | null,
  role: CredentialItem["role"],
  code: string,
  scanSource: CredentialItem["scan_source"] = "camera",
): CredentialItem {
  return { ...camera(role, scanSource), camera_id: code, camera_code: code, station_id: stationId };
}

const kho = [
  at("ban01", "proof_primary", "cam_test", "scanner"),
  at("ban03", "proof_primary", "hik_3"),
  at("ban03", "proof_qr", "dahua_3"),
  at(null, "proof_primary", "cam_hang_doi"),
];

test("QR quét ở BAN_03 chỉ bật ghi camera BAN_03", () => {
  const picked = pickShiftCameras(kho, "ban03").map((c) => c.camera_code);
  assert.deepEqual(picked, ["hik_3", "dahua_3"]);
});

test("QR quét ở BAN_01 không đụng tới camera BAN_03", () => {
  const picked = pickShiftCameras(kho, "ban01").map((c) => c.camera_code);
  assert.deepEqual(picked, ["cam_test"]);
});

test("súng quét không rõ bàn, agent có nhiều bàn: không bật gì, để cloud quyết", () => {
  assert.deepEqual(pickShiftCameras(kho, null), []);
});

test("súng quét không rõ bàn, agent chỉ có một bàn: vẫn bật như trước", () => {
  const motBan = [at("ban03", "proof_primary", "hik_3"), at("ban03", "proof_qr", "dahua_3")];
  const picked = pickShiftCameras(motBan, null).map((c) => c.camera_code);
  assert.deepEqual(picked, ["hik_3", "dahua_3"], "kho một bàn không được mất đường bật ghi nhanh");
});

test("camera ở hàng đợi không bao giờ bị bật ghi", () => {
  const picked = pickShiftCameras(kho, "ban03").map((c) => c.camera_code);
  assert.equal(picked.includes("cam_hang_doi"), false);
});
