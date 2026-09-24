import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  prepareZXingModule as prepareWriterModule,
  writeBarcode,
} from "zxing-wasm/writer";
import { decodeGrayFrame } from "../src/qr/qr-decoder";

/**
 * CAM KẾT VỀ CỠ MÃ ĐỌC ĐƯỢC — chủ dự án chốt 24/09/2026.
 *
 * Hiện trường: camera ống kính 12mm, nhãn giơ cách camera ~50cm, khung
 * hình chỉ rộng hơn tờ A6 một chút (A6 = 10,5 x 14,8cm). Bài test chạy ở
 * tầm nhìn 12cm, 16cm và 23cm — mốc cuối là biên an toàn cho trường hợp
 * camera lùi xa hơn.
 *
 * Phải đọc được:
 *   - QR khổ thường 3x3cm  (vẫn như trước)
 *   - QR nhỏ 2x2cm        (nhãn TikTok — việc chính của đợt này)
 *   - mã vạch Code128 của cùng mã vận đơn
 *
 * Bài test dựng ảnh mô phỏng cả bốn kiểu xấu hay gặp: nét, hơi mờ, mờ +
 * nghiêng 12 độ, và mờ nặng. Mã phải ra đúng trong CẢ BỐN.
 *
 * Bài cuối chứng minh bài test có ý nghĩa: cũng những ảnh đó, đưa qua
 * đường CŨ (ép khung xuống 640x360) thì mã nhỏ đọc không ra.
 */

const CODE = "854160978771"; // mã vận đơn thật trên ảnh nhãn J&T chủ dự án gửi

let ready = false;
function prepareWriter(): void {
  if (ready) return;
  const wasm = readFileSync(require.resolve("zxing-wasm/writer/zxing_writer.wasm"));
  prepareWriterModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
  });
  ready = true;
}

interface Symbol2D {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Vẽ mã lên khung, có xoay, lấy mẫu trung bình vùng như ống kính thật. */
function paint(
  symbol: Symbol2D,
  frameWidth: number,
  frameHeight: number,
  width: number,
  height: number,
  angleDeg: number,
): Uint8Array {
  const out = new Float32Array(frameWidth * frameHeight).fill(235);
  const cx = frameWidth / 2;
  const cy = frameHeight / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const SS = 2;
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      let sum = 0;
      let n = 0;
      let inside = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS - 0.5;
          const py = y + (sy + 0.5) / SS - 0.5;
          const dx = px - cx;
          const dy = py - cy;
          const ux = dx * cos + dy * sin;
          const uy = -dx * sin + dy * cos;
          n += 1;
          if (Math.abs(ux) > width / 2 || Math.abs(uy) > height / 2) {
            sum += 235;
            continue;
          }
          inside += 1;
          const mx = Math.min(symbol.width - 1, Math.floor(((ux + width / 2) / width) * symbol.width));
          const my = Math.min(
            symbol.height - 1,
            Math.floor(((uy + height / 2) / height) * symbol.height),
          );
          sum += symbol.data[my * symbol.width + mx] ?? 255;
        }
      }
      if (inside > 0) out[y * frameWidth + x] = sum / n;
    }
  }
  return Uint8Array.from(out, (v) => Math.max(0, Math.min(255, Math.round(v))));
}

/** Mờ + nhiễu — camera thật không bao giờ cho ảnh sạch tuyệt đối. */
function degrade(
  frame: Uint8Array,
  width: number,
  height: number,
  blurPasses: number,
  noise: number,
): Uint8Array {
  const out = Uint8Array.from(frame);
  for (let pass = 0; pass < blurPasses; pass += 1) {
    const copy = Uint8Array.from(out);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += copy[(y + dy) * width + x + dx];
        }
        out[y * width + x] = Math.round(sum / 9);
      }
    }
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.max(0, Math.min(255, out[i] + Math.round((Math.random() * 2 - 1) * noise)));
  }
  return out;
}

/** Bốn kiểu ảnh xấu hay gặp: [số lần làm mờ, mức nhiễu, độ nghiêng]. */
const CONDITIONS: Array<[string, number, number, number]> = [
  ["nét", 0, 4, 0],
  ["hơi mờ", 1, 8, 6],
  ["mờ + nghiêng 12°", 2, 12, 12],
  ["mờ nặng", 3, 14, 8],
];

/**
 * Tầm nhìn ngang của camera tại chỗ giơ nhãn.
 *
 * Chủ dự án đo 24/09/2026: ống 12mm, nhãn cách ~50cm, "khung camera chỉ
 * bắt được một khoảng lớn hơn tờ A6 một chút" — A6 rộng 10,5cm, nên khung
 * khoảng 12-16cm ngang. Thêm mốc 23cm để có biên an toàn nếu sau này
 * camera lùi ra xa hoặc đổi ống kính rộng hơn.
 */
const FIELD_OF_VIEW_CM = [12, 16, 23];

async function readsEverywhere(
  symbol: Symbol2D,
  widthCm: number,
  heightCm: number,
  frameWidth: number,
  frameHeight: number,
): Promise<string[]> {
  const misses: string[] = [];
  for (const fovCm of FIELD_OF_VIEW_CM) {
    const pxPerCm = frameWidth / fovCm;
    for (const [name, blur, noise, angle] of CONDITIONS) {
      const frame = paint(
        symbol,
        frameWidth,
        frameHeight,
        widthCm * pxPerCm,
        heightCm * pxPerCm,
        angle,
      );
      const decoded = await decodeGrayFrame(
        degrade(frame, frameWidth, frameHeight, blur, noise),
        frameWidth,
        frameHeight,
      );
      if (!decoded.some((d) => d.text === CODE)) misses.push(`${fovCm}cm / ${name}`);
    }
  }
  return misses;
}

test("QR 2x2cm đọc được ở mọi kiểu ảnh xấu — cam kết chính của đợt này", async () => {
  prepareWriter();
  const { symbol } = await writeBarcode(CODE, { format: "QRCode", addQuietZones: true });
  const misses = await readsEverywhere(symbol, 2, 2, 1920, 1080);
  assert.deepEqual(misses, [], `QR 2x2cm đọc không ra ở: ${misses.join(", ")}`);
});

test("QR 3x3cm khổ thường vẫn đọc được — không phá luồng đang chạy", async () => {
  prepareWriter();
  const { symbol } = await writeBarcode(CODE, { format: "QRCode", addQuietZones: true });
  const misses = await readsEverywhere(symbol, 3, 3, 1920, 1080);
  assert.deepEqual(misses, [], `QR 3x3cm đọc không ra ở: ${misses.join(", ")}`);
});

test("mã vạch của cùng mã vận đơn cũng đọc được", async () => {
  prepareWriter();
  const { symbol } = await writeBarcode(CODE, { format: "Code128", addQuietZones: true });
  const misses = await readsEverywhere(symbol, 6, 1.5, 1920, 1080);
  assert.deepEqual(misses, [], `mã vạch đọc không ra ở: ${misses.join(", ")}`);
});

test("đường CŨ (ép 640x360) đọc không ra mã nhỏ — bài test này có ý nghĩa", async () => {
  prepareWriter();
  const { symbol } = await writeBarcode(CODE, { format: "QRCode", addQuietZones: true });
  const misses = await readsEverywhere(symbol, 1.2, 1.2, 640, 360);
  assert.ok(
    misses.length > 0,
    "nếu cách cũ cũng đọc được thì bài test không chứng minh được gì — dựng lại mã nhỏ hơn",
  );
});
