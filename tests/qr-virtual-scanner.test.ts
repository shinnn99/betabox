import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planVirtualScannerRepairs,
  virtualScannerCode,
} from "@/lib/camera/qr-virtual-scanner";

const CAMERA_ID = "f7b00e32-36df-4c31-9078-4f62b5ff256b";
const STATION = "7f5c2e64-a82e-4f7b-957f-8abfc7cf803c";
const OTHER_STATION = "bfaa6f8b-24e6-4250-92dc-4786fe5ce120";
const codes = new Map([[CAMERA_ID, "dahua_3"]]);

const qrCamera = (stationId: string | null) => ({
  deviceId: "9350a655-da27-4624-aa3d-e363a7218b0b",
  cameraId: CAMERA_ID,
  stationId,
  name: "Dahua bàn 3",
});

test("tên scanner ảo luôn viết thường và có tiền tố qrcam_", () => {
  assert.equal(virtualScannerCode("Dahua_3"), "qrcam_dahua_3");
});

test("thiếu hẳn scanner ảo thì tạo mới và gán vào đúng bàn của camera", () => {
  const repairs = planVirtualScannerRepairs({
    qrCameraDevices: [qrCamera(STATION)],
    virtualScanners: [],
    cameraCodeById: codes,
  });
  assert.deepEqual(repairs, [
    {
      kind: "create",
      deviceCode: "qrcam_dahua_3",
      cameraId: CAMERA_ID,
      stationId: STATION,
      name: "QR camera Dahua bàn 3",
    },
  ]);
});

test("đã đúng rồi thì không sửa gì", () => {
  const repairs = planVirtualScannerRepairs({
    qrCameraDevices: [qrCamera(STATION)],
    virtualScanners: [
      {
        deviceId: "v1",
        deviceCode: "qrcam_dahua_3",
        status: "active",
        stationId: STATION,
      },
    ],
    cameraCodeById: codes,
  });
  assert.deepEqual(repairs, []);
});

test("scanner ảo bị archive thì bật lại, không tạo bản trùng tên", () => {
  const repairs = planVirtualScannerRepairs({
    qrCameraDevices: [qrCamera(STATION)],
    virtualScanners: [
      {
        deviceId: "v1",
        deviceCode: "qrcam_dahua_3",
        status: "archived",
        stationId: null,
      },
    ],
    cameraCodeById: codes,
  });
  assert.deepEqual(repairs, [
    { kind: "activate", deviceId: "v1", deviceCode: "qrcam_dahua_3" },
    { kind: "assign", deviceId: "v1", deviceCode: "qrcam_dahua_3", stationId: STATION },
  ]);
});

test("scanner ảo đang gán nhầm bàn khác thì kéo về bàn của camera", () => {
  const repairs = planVirtualScannerRepairs({
    qrCameraDevices: [qrCamera(STATION)],
    virtualScanners: [
      {
        deviceId: "v1",
        deviceCode: "qrcam_dahua_3",
        status: "active",
        stationId: OTHER_STATION,
      },
    ],
    cameraCodeById: codes,
  });
  assert.deepEqual(repairs, [
    { kind: "assign", deviceId: "v1", deviceCode: "qrcam_dahua_3", stationId: STATION },
  ]);
});

// Hai trường hợp dưới đây là chỗ dễ sinh rác nhất — khoá lại bằng test.

test("camera chưa gán vào bàn nào thì không tạo gì", () => {
  const repairs = planVirtualScannerRepairs({
    qrCameraDevices: [qrCamera(null)],
    virtualScanners: [],
    cameraCodeById: codes,
  });
  assert.deepEqual(repairs, [], "không có bàn để soi chiếu thì scanner ảo chỉ là rác");
});

test("không tra được mã camera thì bỏ qua, không đoán tên thiết bị", () => {
  const repairs = planVirtualScannerRepairs({
    qrCameraDevices: [qrCamera(STATION)],
    virtualScanners: [],
    cameraCodeById: new Map(),
  });
  assert.deepEqual(repairs, []);
});
