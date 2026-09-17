import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCameraStations } from "@/lib/camera/camera-stations";

/**
 * Một agent phục vụ mọi bàn trong kho. Vai trò, nguồn quét và ca mở phải
 * tính theo bàn CỦA TỪNG CAMERA — không lấy chung bàn của agent.
 *
 * Bộ dữ liệu dưới đây là trạng thái thật ngày 17/09/2026: EZVIZ CAM_TEST ở
 * BAN_01, hik_3 + dahua_3 ở BAN_03, cả ba cùng một agent.
 */

const BAN_01 = "ban01";
const BAN_03 = "ban03";
const CAM_TEST = "cam-test";
const HIK_3 = "hik-3";
const DAHUA_3 = "dahua-3";
const CHUA_GAN = "cam-cho";

const devices = [
  { id: "d-cam-test", config_json: { camera_id: CAM_TEST, role: "proof_primary" } },
  { id: "d-hik-3", config_json: { camera_id: HIK_3, role: "proof_primary" } },
  { id: "d-dahua-3", config_json: { camera_id: DAHUA_3, role: "proof_qr" } },
  { id: "d-cho", config_json: { camera_id: CHUA_GAN, role: "proof_qr" } },
];
const assignments = [
  { device_id: "d-cam-test", station_id: BAN_01 },
  { device_id: "d-hik-3", station_id: BAN_03 },
  { device_id: "d-dahua-3", station_id: BAN_03 },
  // d-cho không có phân công đang mở: camera nằm ở hàng đợi.
];
const stations = [
  { id: BAN_01, scan_source: "scanner" },
  { id: BAN_03, scan_source: "camera" },
];

test("mỗi camera nhận đúng bàn của nó, không phải bàn của agent", () => {
  const info = resolveCameraStations({
    cameraIds: [CAM_TEST, HIK_3, DAHUA_3],
    devices,
    assignments,
    stations,
    openSessionStationIds: new Set([BAN_03]),
  });
  assert.equal(info.get(CAM_TEST)?.stationId, BAN_01);
  assert.equal(info.get(HIK_3)?.stationId, BAN_03);
  assert.equal(info.get(DAHUA_3)?.stationId, BAN_03);
});

test("vai trò, nguồn quét và ca mở đều đi theo bàn của từng camera", () => {
  const info = resolveCameraStations({
    cameraIds: [CAM_TEST, DAHUA_3],
    devices,
    assignments,
    stations,
    openSessionStationIds: new Set([BAN_03]), // chỉ BAN_03 đang có ca
  });
  assert.deepEqual(info.get(CAM_TEST), {
    stationId: BAN_01,
    role: "proof_primary",
    scanSource: "scanner",
    stationHasOpenSession: false,
  });
  assert.deepEqual(info.get(DAHUA_3), {
    stationId: BAN_03,
    role: "proof_qr",
    scanSource: "camera",
    stationHasOpenSession: true,
  });
});

test("mở ca ở bàn này không làm camera bàn khác thành đang có ca", () => {
  const info = resolveCameraStations({
    cameraIds: [CAM_TEST, HIK_3],
    devices,
    assignments,
    stations,
    openSessionStationIds: new Set([BAN_01]),
  });
  assert.equal(info.get(CAM_TEST)?.stationHasOpenSession, true);
  assert.equal(
    info.get(HIK_3)?.stationHasOpenSession,
    false,
    "ca ở BAN_01 mà bật ghi BAN_03 là trộn bằng chứng của hai bàn",
  );
});

test("camera ở hàng đợi không có bàn, không vai trò, không bao giờ có ca", () => {
  const info = resolveCameraStations({
    cameraIds: [CHUA_GAN],
    devices,
    assignments,
    stations,
    openSessionStationIds: new Set([BAN_01, BAN_03]),
  });
  assert.deepEqual(info.get(CHUA_GAN), {
    stationId: null,
    role: null,
    scanSource: "scanner",
    stationHasOpenSession: false,
  });
});

test("vai trò rác thì coi như chưa đặt vị trí, không đoán thành toàn cảnh", () => {
  const info = resolveCameraStations({
    cameraIds: [CAM_TEST],
    devices: [{ id: "d-cam-test", config_json: { camera_id: CAM_TEST, role: "chinh" } }],
    assignments,
    stations,
    openSessionStationIds: new Set(),
  });
  assert.equal(info.get(CAM_TEST)?.role, null);
  assert.equal(info.get(CAM_TEST)?.stationId, BAN_01);
});
