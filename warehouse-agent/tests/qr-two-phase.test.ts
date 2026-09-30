import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  prepareZXingModule as prepareWriterModule,
  writeBarcode,
} from "zxing-wasm/writer";
import {
  decodeGrayFrame,
  forgetDecoderState,
  slowPhaseRunCount,
} from "../src/qr/qr-decoder";
import { QR_FRAME_HEIGHT, QR_FRAME_WIDTH } from "../src/qr/qr-frame-source";

/**
 * Bộ giải mã HAI PHA (30/09/2026).
 *
 * Sự cố: sau khi mở thêm mã vạch, nhân viên phải giơ nhãn rất lâu mới ăn.
 * Gốc rễ không phải mã vạch mà là tổng của ba thay đổi trong cùng một
 * commit (2a57b63) — cỡ khung 640x360 -> 2560x1440, 1 -> 9 định dạng, và
 * bốn cờ `try*` bật hết. Khung TRỐNG mất 166ms trong khi ngân sách chỉ có
 * 100ms (10 khung/giây), nên `decoderBusy` vứt 2 trong 3 khung; qr-zone
 * lại đòi hai khung liên tiếp cùng đọc ra một mã mới phát lượt quét.
 *
 * Hai bài dưới đây canh HAI VẾ, vì fix chỉ đúng khi cả hai cùng đạt:
 * nhanh hơn ngân sách, VÀ không mất mã nhỏ.
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

function paintCode(
  symbol: { data: Uint8Array; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
  codePixels: number,
): Uint8Array {
  const frame = new Uint8Array(frameWidth * frameHeight).fill(255);
  const left = Math.floor((frameWidth - codePixels) / 2);
  const top = Math.floor((frameHeight - codePixels) / 2);
  for (let y = 0; y < codePixels; y += 1) {
    const srcY = Math.min(symbol.height - 1, Math.floor((y * symbol.height) / codePixels));
    for (let x = 0; x < codePixels; x += 1) {
      const srcX = Math.min(symbol.width - 1, Math.floor((x * symbol.width) / codePixels));
      frame[(top + y) * frameWidth + left + x] = symbol.data[srcY * symbol.width + srcX] ?? 255;
    }
  }
  return frame;
}

/** Khung trống có nhiễu nhẹ — giống ảnh camera thật, không phải nền trắng tinh. */
function blankFrame(w: number, h: number): Uint8Array {
  const frame = new Uint8Array(w * h);
  for (let i = 0; i < frame.length; i += 1) frame[i] = 200 + ((i * 7919) % 40);
  return frame;
}

/**
 * TỐC ĐỘ canh bằng SỐ LẦN chạy pha kỹ, KHÔNG bằng đồng hồ.
 *
 * Đã thử hai cách đo bằng thời gian và cả hai đều đỏ ngẫu nhiên:
 *   1. Mốc tuyệt đối "dưới 100ms": chạy riêng xanh (91ms), chạy cả bộ đỏ
 *      (524ms).
 *   2. So tương đối "khung sau phải rẻ hơn nửa khung đầu": vẫn đỏ (1159ms
 *      so 588ms).
 * Lý do chung: trình chạy test của Node mở song song nhiều file trên 8
 * lõi, nên con số đo được là TẢI MÁY chứ không phải chi phí giải mã.
 *
 * Thứ thật sự cần canh là BẤT BIẾN sinh ra tốc độ: trong một khoảng hoãn,
 * pha kỹ chỉ được chạy đúng MỘT lần. Đếm số lần thì tất định — không phụ
 * thuộc máy nhanh hay chậm, máy rảnh hay bận.
 *
 * Con số thời gian thật đo tay 30/09/2026 trên máy rảnh, ghi ở
 * qr-decoder.ts và RELEASES.md: 189ms (bản cũ, 2560x1440) -> 12ms.
 */
test("TỐC ĐỘ: sáu khung trống liên tiếp chỉ tốn pha kỹ MỘT lần", async () => {
  const cam = "cam-toc-do";
  forgetDecoderState(cam);
  const frame = blankFrame(QR_FRAME_WIDTH, QR_FRAME_HEIGHT);

  // Khung trống là khung ĐẮT nhất: không có mã thì bộ giải mã phải quét
  // cạn ảnh mới dám kết luận. Đây cũng là cảnh ~99% thời gian, nên đây
  // chính là chỗ bản cũ đốt 189ms mỗi khung và làm rơi khung.
  for (let i = 0; i < 6; i += 1) {
    await decodeGrayFrame(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, cam);
  }

  assert.equal(
    slowPhaseRunCount(cam),
    1,
    "sáu khung trong cùng một khoảng hoãn chỉ được chạy pha kỹ một lần",
  );
});

test("TỐC ĐỘ: hết khoảng hoãn thì pha kỹ được chạy lại", async () => {
  const cam = "cam-het-hoan";
  forgetDecoderState(cam);
  const frame = blankFrame(QR_FRAME_WIDTH, QR_FRAME_HEIGHT);

  await decodeGrayFrame(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, cam);
  await decodeGrayFrame(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, cam);
  assert.equal(slowPhaseRunCount(cam), 1, "khung thứ hai còn trong khoảng hoãn");

  // Quá 500ms — pha kỹ tới lượt lại, không thì mã mờ/nghiêng sẽ không bao
  // giờ được dò kỹ nữa.
  await new Promise((r) => setTimeout(r, 550));
  await decodeGrayFrame(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, cam);
  assert.equal(slowPhaseRunCount(cam), 2, "hết khoảng hoãn phải chạy lại pha kỹ");
});

test("ĐỘ CHÍNH XÁC: mã nhỏ (nhãn TikTok 12mm) vẫn đọc được", async () => {
  prepareWriter();
  const code = "TTVN1234567890123";
  const { symbol } = await writeBarcode(code, { format: "QRCode", addQuietZones: true });

  // Camera 2K thu về trần 1920: mã 12mm còn ~37px. Pha nhanh thường trượt
  // cỡ này — pha kỹ phải gánh, đó là lý do nó tồn tại.
  const frame = paintCode(symbol, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, 37);
  const cam = "cam-ma-nho";
  forgetDecoderState(cam);

  const decoded = await decodeGrayFrame(frame, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, cam);
  assert.equal(decoded[0]?.text, code, "hạ trần + hai pha vẫn phải đọc được mã nhỏ");
});

test("ĐỘ CHÍNH XÁC: mã vạch Code128 vẫn đọc được qua pha nhanh", async () => {
  prepareWriter();
  const code = "TTVN1099351268";
  const written = await writeBarcode(code, { format: "Code128" });
  const cam = "cam-ma-vach";
  forgetDecoderState(cam);

  const decoded = await decodeGrayFrame(
    written.symbol.data,
    written.symbol.width,
    written.symbol.height,
    cam,
  );
  assert.equal(decoded[0]?.text, code);
  assert.equal(decoded[0]?.kind, "barcode");
});

test("định dạng hiếm (Code39) vẫn đọc được — pha kỹ không bỏ sót", async () => {
  prepareWriter();
  const code = "SPXVN062557638";
  const written = await writeBarcode(code, { format: "Code39" });
  const cam = "cam-code39";
  forgetDecoderState(cam);

  const decoded = await decodeGrayFrame(
    written.symbol.data,
    written.symbol.width,
    written.symbol.height,
    cam,
  );
  assert.equal(decoded[0]?.text, code, "Code39 không nằm trong pha nhanh, pha kỹ phải bắt được");
});

test("hoãn pha kỹ là RIÊNG từng camera — bàn này không bịt mắt bàn kia", async () => {
  prepareWriter();
  const code = "TTVN5555666677";
  const { symbol } = await writeBarcode(code, { format: "QRCode", addQuietZones: true });
  const small = paintCode(symbol, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, 37);
  const blank = blankFrame(QR_FRAME_WIDTH, QR_FRAME_HEIGHT);

  forgetDecoderState("ban-A");
  forgetDecoderState("ban-B");

  // Bàn A vừa đốt lượt pha kỹ vào một khung trống.
  await decodeGrayFrame(blank, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, "ban-A");

  // Bàn B giơ mã nhỏ ngay lúc đó: phải đọc được, không bị lượt hoãn của A
  // ăn mất.
  const decoded = await decodeGrayFrame(small, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, "ban-B");
  assert.equal(decoded[0]?.text, code);
});

test("không nêu camera thì không hoãn — giữ nguyên đường thử giải mã", async () => {
  prepareWriter();
  const code = "TTVN9999000011";
  const { symbol } = await writeBarcode(code, { format: "QRCode", addQuietZones: true });
  const small = paintCode(symbol, QR_FRAME_WIDTH, QR_FRAME_HEIGHT, 37);

  // Gọi liên tiếp hai lần không nêu camera: cả hai đều phải chạy pha kỹ.
  assert.equal((await decodeGrayFrame(small, QR_FRAME_WIDTH, QR_FRAME_HEIGHT))[0]?.text, code);
  assert.equal((await decodeGrayFrame(small, QR_FRAME_WIDTH, QR_FRAME_HEIGHT))[0]?.text, code);
});
