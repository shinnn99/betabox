import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Lưới chặn xoá camera còn đơn TRONG HẠN (`deleteCamera` — service.ts).
 *
 * Vì sao cần lưới thứ hai khi đã có RESTRICT ở `order_proof_clips`: khoá ngoại
 * đó chỉ thấy những đơn ĐÃ có người bấm xem clip. Đơn chưa ai xem thì không có
 * dòng clip nào nên không gì chặn — mà đó mới là phần lớn.
 *
 * Đo trên dữ liệu thật 25/09/2026: camera `CQR01` có 0 clip (RESTRICT không
 * chặn) nhưng gánh 1.122 bản ghi `camera_recording_files` (21 GB) và 230 đơn
 * còn trong hạn 35 ngày. Xoá là mất đường cắt clip cho cả 230 đơn đó: file
 * .mp4 trên ổ máy kho vẫn còn nhưng không còn gì trỏ tới.
 *
 * Hàm thật chạm DB nên không gọi trực tiếp được ở đây. Tái dựng đúng chuỗi
 * quyết định của nó và khẳng định từng nhánh.
 */

interface DeleteInput {
  clipsCount: number;
  /** Đơn có proof_camera_id / proof_qr_camera_id trỏ tới camera, trong hạn. */
  recentOrders: number;
  filesCount: number;
  /** `organizations.retention_days`; null = chưa cấu hình. */
  retentionDays: number | null;
}

type Verdict =
  | { blocked: true; reason: "has_proof_clips" | "has_recent_orders" }
  | { blocked: false };

/** Bản sao chuỗi quyết định trong deleteCamera. */
function planDelete(input: DeleteInput): Verdict {
  if (input.clipsCount > 0) {
    return { blocked: true, reason: "has_proof_clips" };
  }
  const days = input.retentionDays;
  // retention_days NULL/không hợp lệ → không suy ra cửa sổ, không chặn theo đơn.
  if (days !== null && Number.isFinite(days) && days > 0) {
    if (input.recentOrders > 0) {
      return { blocked: true, reason: "has_recent_orders" };
    }
  }
  return { blocked: false };
}

test("ca CQR01 thật: 0 clip nhưng 230 đơn trong hạn → phải chặn", () => {
  const verdict = planDelete({
    clipsCount: 0,
    recentOrders: 230,
    filesCount: 1122,
    retentionDays: 35,
  });
  assert.deepEqual(verdict, { blocked: true, reason: "has_recent_orders" });
});

test("lưới clip vẫn chạy trước: có clip thì chặn bằng has_proof_clips", () => {
  const verdict = planDelete({
    clipsCount: 45,
    recentOrders: 2063,
    filesCount: 20476,
    retentionDays: 35,
  });
  assert.deepEqual(verdict, { blocked: true, reason: "has_proof_clips" });
});

test("camera sạch thật sự thì vẫn xoá được — lưới không chặn bừa", () => {
  const verdict = planDelete({
    clipsCount: 0,
    recentOrders: 0,
    filesCount: 74,
    retentionDays: 35,
  });
  assert.deepEqual(verdict, { blocked: false });
});

test("đơn đã quá hạn không giữ camera lại: hết hạn thì cho xoá", () => {
  // Đơn cũ hơn retention → không nằm trong recentOrders, dù camera từng ghi
  // rất nhiều file. Giữ camera lại lúc này là giữ rác.
  const verdict = planDelete({
    clipsCount: 0,
    recentOrders: 0,
    filesCount: 20476,
    retentionDays: 35,
  });
  assert.deepEqual(verdict, { blocked: false });
});

test("chưa cấu hình retention_days thì KHÔNG chặn theo đơn", () => {
  // Không có cửa sổ thì không tự đặt số. Thà để lưới clip gánh còn hơn chặn
  // bừa bằng con số bịa ra.
  const verdict = planDelete({
    clipsCount: 0,
    recentOrders: 230,
    filesCount: 1122,
    retentionDays: null,
  });
  assert.deepEqual(verdict, { blocked: false });
});

test("retention_days = 0 cũng coi như chưa cấu hình", () => {
  const verdict = planDelete({
    clipsCount: 0,
    recentOrders: 230,
    filesCount: 1122,
    retentionDays: 0,
  });
  assert.deepEqual(verdict, { blocked: false });
});

/**
 * Nhận diện máy quét ảo trên giao diện (devices/page.tsx).
 *
 * Quy tắc tên phải khớp `virtualScannerCode()` trong
 * src/lib/camera/qr-virtual-scanner.ts — lệch là nhãn nút hiện sai bản chất.
 */
function isVirtualScanner(deviceCode: string): boolean {
  return deviceCode.toLowerCase().startsWith("qrcam_");
}

test("máy quét ảo nhận diện đúng theo tiền tố qrcam_", () => {
  assert.equal(isVirtualScanner("qrcam_cqr01"), true);
  assert.equal(isVirtualScanner("QRCAM_CQR01"), true, "không phân biệt hoa thường");
  assert.equal(isVirtualScanner("qrcam_dahua_3"), true);
});

test("súng quét thật KHÔNG bị nhận nhầm là ảo", () => {
  // Nhận nhầm sẽ báo "hệ thống sẽ tự bật lại" trong khi không có gì bật lại,
  // và người vận hành tưởng bàn vẫn quét được.
  assert.equal(isVirtualScanner("MAY_QUET_01"), false);
  assert.equal(isVirtualScanner("SCANNER_QR_01"), false);
  assert.equal(isVirtualScanner("auto_CQR01"), false, "thiết bị camera không phải scanner ảo");
});

/**
 * Ẩn nút Lưu trữ cho máy quét ảo đang được dùng (devices/page.tsx).
 *
 * Phải khớp lưới ở `DELETE /api/station-devices/[id]`: nút hiện ra mà API từ
 * chối thì người vận hành tưởng hệ thống hỏng; nút ẩn mà API cho phép thì mất
 * đường thao tác hợp lệ. Hai bên lệch nhau kiểu nào cũng sai.
 */
interface StationLite {
  id: string;
  scan_source?: "scanner" | "camera" | null;
}

function virtualScannerLocked(
  deviceCode: string,
  stationId: string | undefined,
  stations: StationLite[],
): boolean {
  if (!deviceCode.toLowerCase().startsWith("qrcam_")) return false;
  if (!stationId) return false;
  const station = stations.find((st) => st.id === stationId);
  return station?.scan_source === "camera";
}

const BAN_CAMERA: StationLite[] = [{ id: "ban-01", scan_source: "camera" }];
const BAN_SUNG: StationLite[] = [{ id: "ban-01", scan_source: "scanner" }];

test("ca thật: qrcam_cqr01 ở bàn đọc mã bằng camera → khoá nút", () => {
  assert.equal(virtualScannerLocked("qrcam_cqr01", "ban-01", BAN_CAMERA), true);
});

test("bàn đã chuyển về súng quét → MỞ nút, vì lúc đó gỡ được thật", () => {
  assert.equal(virtualScannerLocked("qrcam_cqr01", "ban-01", BAN_SUNG), false);
});

test("súng quét thật ở chính bàn dùng camera vẫn lưu trữ được", () => {
  // Vế âm quan trọng nhất: MAY_QUET_01 cùng bàn BAN_01 với máy quét ảo bị
  // khoá, nhưng nó là thiết bị thật — khoá nhầm là chặn mất việc hợp lệ.
  assert.equal(virtualScannerLocked("MAY_QUET_01", "ban-01", BAN_CAMERA), false);
});

test("máy quét ảo chưa gán bàn nào → không khoá", () => {
  assert.equal(virtualScannerLocked("qrcam_cqr01", undefined, BAN_CAMERA), false);
});

test("không tra được bàn thì KHÔNG khoá — thà để API từ chối còn hơn giấu nút", () => {
  assert.equal(virtualScannerLocked("qrcam_cqr01", "ban-lạ", BAN_CAMERA), false);
});
