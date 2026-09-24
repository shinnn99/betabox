import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  prepareZXingModule as prepareWriterModule,
  writeBarcode,
} from "zxing-wasm/writer";
import { looksLikeWaybill, pickScanCode, type CodeCandidate } from "../src/qr/code-pick";
import { decodeGrayFrame } from "../src/qr/qr-decoder";
import { QrZone } from "../src/qr/qr-zone";

/**
 * Đọc CẢ mã vạch (chủ dự án 24/09/2026: "đôi khi QR bé nhưng barcode vẫn
 * rõ ràng hơn").
 *
 * Rủi ro đi kèm: một nhãn vận đơn in 2-3 mã vạch, đọc bừa là tạo đơn
 * không có thật. Luật chọn ở code-pick.ts, và phần lớn bài test dưới đây
 * canh đúng luật đó.
 */

let writerReady = false;
function prepareWriter(): void {
  if (writerReady) return;
  const wasm = readFileSync(require.resolve("zxing-wasm/writer/zxing_writer.wasm"));
  prepareWriterModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
  });
  writerReady = true;
}

function box(x: number, y: number, size: number, ratio = 1) {
  return { x, y, width: size, height: size * ratio };
}

const qr = (text: string, size: number): CodeCandidate => ({
  text,
  box: box(0, 0, size),
  kind: "qr",
});
const barcode = (text: string, size: number): CodeCandidate => ({
  text,
  box: box(0, 0, size, 0.3),
  kind: "barcode",
});

test("đọc được mã vạch Code128 thật", async () => {
  prepareWriter();
  const text = "TTVN1099351268";
  const written = await writeBarcode(text, { format: "Code128" });
  const decoded = await decodeGrayFrame(
    written.symbol.data,
    written.symbol.width,
    written.symbol.height,
  );
  assert.equal(decoded[0]?.text, text);
  assert.equal(decoded[0]?.kind, "barcode", "phải nhận ra đây là mã vạch, không phải QR");
});

test("QR vẫn đọc được và được ghi là mã hai chiều", async () => {
  prepareWriter();
  const written = await writeBarcode("SPXVN0123456789", { format: "QRCode", addQuietZones: true });
  const decoded = await decodeGrayFrame(
    written.symbol.data,
    written.symbol.width,
    written.symbol.height,
  );
  assert.equal(decoded[0]?.text, "SPXVN0123456789");
  assert.equal(decoded[0]?.kind, "qr");
});

test("nhãn J&T thật: mã vận đơn in lặp lại nên nó thắng", () => {
  // Ảnh chủ dự án gửi 24/09/2026: 854160978771 in ở mã vạch ngang, QR và
  // hai mã vạch dọc; mã phân loại chỉ có một lần.
  const picked = pickScanCode([
    barcode("854160978771", 320),
    qr("854160978771", 45),
    barcode("854160978771", 110),
    barcode("854160978771", 108),
    barcode("B024J18001410", 300),
  ]);
  assert.equal(picked.picked?.text, "854160978771");
  assert.ok(!picked.ambiguous);
});

test("không ưu tiên QR hay mã vạch — bắt được cái nào nhận cái đó", () => {
  // Chỉ đọc được QR trong khung.
  assert.equal(pickScanCode([qr("854160978771", 45)]).picked?.text, "854160978771");
  // Chỉ đọc được mã vạch.
  assert.equal(pickScanCode([barcode("854160978771", 320)]).picked?.text, "854160978771");
});

test("cùng nội dung in cả QR lẫn mã vạch thì không coi là hai mã", () => {
  const picked = pickScanCode([qr("TTVN1099351268", 40), barcode("TTVN1099351268", 300)]);
  assert.equal(picked.picked?.text, "TTVN1099351268");
  assert.ok(!picked.ambiguous);
});

test("nhiều mã vạch khác nội dung, mỗi cái một lần: lấy mã to nhất", () => {
  const picked = pickScanCode([
    barcode("TTVN1099351268", 320),
    barcode("PHANLOAI0012345", 90),
  ]);
  assert.equal(picked.picked?.text, "TTVN1099351268");
});

test("hai nhãn cùng trong khung thì KHÔNG đoán", () => {
  // Hai mã khác nhau, cùng số lần xuất hiện, to xấp xỉ nhau.
  const picked = pickScanCode([
    barcode("TTVN1099351268", 300),
    barcode("TTVN1099351269", 280),
  ]);
  assert.ok(picked.ambiguous, "phải báo mơ hồ thay vì chọn bừa");
  assert.equal(picked.picked, undefined);
});

test("hai QR trong khung vẫn là mơ hồ như trước", () => {
  const picked = pickScanCode([qr("A1234567890", 60), qr("B1234567890", 58)]);
  assert.ok(picked.ambiguous);
});

test("mã tuyến / mã kho ngắn bị loại, không tạo được đơn rác", () => {
  for (const rác of ["HN01", "3A", "BAN 01", "ABCDEFGH", "12345"]) {
    assert.equal(looksLikeWaybill(rác), false, `phải loại: ${rác}`);
  }
  for (const that of ["TTVN1099351268", "SPXVN062557638709", "260923Q5MYXBJT", "862491521365"]) {
    assert.equal(looksLikeWaybill(that), true, `phải nhận: ${that}`);
  }
  // Chỉ có mã tuyến trong khung thì không phát gì cả.
  assert.deepEqual(pickScanCode([barcode("HN01", 300)]), {});
});

test("vùng quét phát mã vạch sau đủ số khung xác nhận", () => {
  const zone = new QrZone(2, 2_000);
  const at = (ms: number) => new Date(1_000_000 + ms);
  const frame = [barcode("TTVN1099351268", 300), barcode("HN01", 280)];
  assert.deepEqual(zone.ingest(frame, at(0)), {}, "một khung chưa đủ");
  const result = zone.ingest(frame, at(100));
  assert.equal(result.emission?.text, "TTVN1099351268");
});
