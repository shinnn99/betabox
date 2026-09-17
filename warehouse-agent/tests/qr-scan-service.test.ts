import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialItem } from "../src/commands";
import { QrScanService, type CameraQrScan } from "../src/qr/qr-scan-service";
import type { DecodedQr } from "../src/qr/qr-zone";

/**
 * Một agent phục vụ nhiều bàn: bộ đọc QR phải chạy MỘT luồng cho MỖI bàn
 * quét bằng camera, và mã đọc được ở bàn nào phải mang đúng camera bàn đó.
 *
 * Trước đây dịch vụ chỉ giữ một camera (`find` phần tử đầu), nên bàn thứ
 * hai quét gì cũng im lặng.
 */

function qrCam(code: string, stationId: string | null, scanSource: "camera" | "scanner"): CredentialItem {
  return {
    camera_id: code,
    camera_code: code,
    rtsp_url: `rtsp://x/${code}`,
    rtsp_substream_url: null,
    transport: "tcp",
    segment_seconds: 60,
    station_id: stationId,
    role: "proof_qr",
    scan_source: scanSource,
    scanner_device_code: `qrcam_${code}`,
    station_has_open_session: false,
  };
}

/** Nguồn giả: ghi lại luồng nào đang chạy và cho phép bơm khung hình. */
function harness(decodeTable: Record<string, DecodedQr[]> = {}) {
  const running = new Map<string, (frame: Uint8Array, at: Date) => void>();
  const stopped: string[] = [];
  const scans: CameraQrScan[] = [];

  const service = new QrScanService({
    ffmpegBin: "ffmpeg",
    frameRate: 10,
    confirmFrames: 1,
    absenceMs: 1000,
    onScan: (scan) => {
      scans.push(scan);
    },
    createSource: (pathName, onFrame) => ({
      start: () => {
        running.set(pathName, onFrame);
      },
      stop: async () => {
        running.delete(pathName);
        stopped.push(pathName);
      },
    }),
    // Mỗi khung hình mang tên luồng trong byte đầu để bộ giải mã giả biết
    // đang "nhìn" camera nào.
    decode: async (frame) => decodeTable[new TextDecoder().decode(frame)] ?? [],
  });

  const feed = async (pathName: string) => {
    const onFrame = running.get(pathName);
    assert.ok(onFrame, `luồng ${pathName} phải đang chạy`);
    onFrame(new TextEncoder().encode(pathName), new Date());
    await new Promise((r) => setTimeout(r, 5));
  };

  return { service, running, stopped, scans, feed };
}

const pathOf = (code: string) =>
  `c${Buffer.from(code).toString("hex")}m`;

test("hai bàn quét bằng camera thì chạy hai luồng song song", async () => {
  const h = harness();
  await h.service.reconcile([qrCam("dahua_3", "ban03", "camera"), qrCam("ezviz_1", "ban01", "camera")]);
  assert.deepEqual(h.service.activeCameraIds().sort(), ["dahua_3", "ezviz_1"]);
  assert.equal(h.running.size, 2);
});

test("bàn dùng súng quét và camera ở hàng đợi thì không mở luồng", async () => {
  const h = harness();
  await h.service.reconcile([
    qrCam("cam_ban_sung", "ban02", "scanner"),
    qrCam("cam_hang_doi", null, "camera"),
  ]);
  assert.deepEqual(h.service.activeCameraIds(), []);
});

test("camera rời bàn thì chỉ dừng luồng của nó, bàn khác chạy tiếp", async () => {
  const h = harness();
  const dahua = qrCam("dahua_3", "ban03", "camera");
  await h.service.reconcile([dahua, qrCam("ezviz_1", "ban01", "camera")]);
  await h.service.reconcile([dahua]);
  assert.deepEqual(h.service.activeCameraIds(), ["dahua_3"]);
  assert.deepEqual(h.stopped, [pathOf("ezviz_1")]);
});

test("mã đọc ở bàn nào thì mang đúng camera bàn đó", async () => {
  const h = harness({
    [pathOf("ezviz_1")]: [{ text: "SPX-BAN01", box: { x: 0, y: 0, width: 10, height: 10 } }],
  });
  await h.service.reconcile([qrCam("dahua_3", "ban03", "camera"), qrCam("ezviz_1", "ban01", "camera")]);
  await h.feed(pathOf("ezviz_1"));
  assert.equal(h.scans.length, 1);
  assert.equal(h.scans[0].camera.camera_code, "ezviz_1");
  assert.equal(h.scans[0].camera.station_id, "ban01");
});

test("cùng một mã ở hai bàn không bị nuốt thành quét trùng", async () => {
  const same = [{ text: "SPX-CHUNG", box: { x: 0, y: 0, width: 10, height: 10 } }];
  const h = harness({ [pathOf("dahua_3")]: same, [pathOf("ezviz_1")]: same });
  await h.service.reconcile([qrCam("dahua_3", "ban03", "camera"), qrCam("ezviz_1", "ban01", "camera")]);
  await h.feed(pathOf("dahua_3"));
  await h.feed(pathOf("ezviz_1"));
  assert.deepEqual(
    h.scans.map((s) => s.camera.camera_code).sort(),
    ["dahua_3", "ezviz_1"],
    "vùng khử trùng dùng chung sẽ bỏ mất lần quét ở bàn thứ hai",
  );
});

test("tắt dịch vụ thì dừng mọi luồng", async () => {
  const h = harness();
  await h.service.reconcile([qrCam("dahua_3", "ban03", "camera"), qrCam("ezviz_1", "ban01", "camera")]);
  await h.service.stop();
  assert.equal(h.running.size, 0);
  assert.deepEqual(h.service.activeCameraIds(), []);
});
