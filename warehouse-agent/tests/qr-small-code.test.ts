import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  prepareZXingModule as prepareWriterModule,
  writeBarcode,
} from "zxing-wasm/writer";
import { decodeGrayFrame } from "../src/qr/qr-decoder";
import {
  QR_FALLBACK_HEIGHT,
  QR_FALLBACK_WIDTH,
  QR_FRAME_HEIGHT,
  QR_FRAME_WIDTH,
  buildQrFrameArgs,
  fitWithinCap,
  probeTargetSize,
} from "../src/qr/qr-frame-source";

/**
 * Mã QR NHỎ trên nhãn TikTok (chủ dự án báo 24/09/2026).
 *
 * Nhãn thường in mã ~25mm, nhãn TikTok ~12mm. Camera 2K nhìn khoảng 60cm
 * bề ngang thì mã 12mm chiếm ~50 pixel trên ảnh GỐC — đủ đọc. Nhưng agent
 * lại bóp mọi khung hình xuống 640 bề ngang trước khi giải mã, còn ~12
 * pixel: mất sạch.
 *
 * Bài test dựng đúng đường đi đó: vẽ mã vào khung 2560x1440, rồi so
 * "đọc thẳng khung gốc" với "bóp xuống 640x360 rồi mới đọc".
 */

const CODE = "TTVN1234567890123";

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

/** Vẽ mã QR cỡ `codePixels` vào giữa một khung xám trắng. */
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

/** Thu nhỏ khung bằng trung bình ô — đúng kiểu `scale` của ffmpeg. */
function downscale(
  frame: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight);
  const xStep = width / outWidth;
  const yStep = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor(y * yStep);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yStep));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor(x * xStep);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xStep));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          sum += frame[sy * width + sx] ?? 255;
          count += 1;
        }
      }
      out[y * outWidth + x] = count > 0 ? Math.round(sum / count) : 255;
    }
  }
  return out;
}

test("mã nhỏ: đọc thẳng khung gốc thì được, bóp xuống 640 thì mất", async () => {
  prepareWriter();
  const { symbol } = await writeBarcode(CODE, { format: "QRCode", addQuietZones: true });

  // Camera 2K, nhãn TikTok ~12mm trong tầm nhìn 60cm → khoảng 50 pixel.
  const native = paintCode(symbol, 2560, 1440, 50);
  const squeezed = downscale(native, 2560, 1440, 640, 360);

  const readNative = await decodeGrayFrame(native, 2560, 1440);
  const readSqueezed = await decodeGrayFrame(squeezed, 640, 360);

  assert.equal(readNative[0]?.text, CODE, "đọc ở độ phân giải gốc phải ra mã");
  assert.notEqual(readSqueezed[0]?.text, CODE, "cách cũ (bóp xuống 640) đọc không ra");
});

test("mã khổ thường vẫn đọc được — không phá luồng đóng hàng đang chạy", async () => {
  prepareWriter();
  const { symbol } = await writeBarcode("SPXVN0123456789", {
    format: "QRCode",
    addQuietZones: true,
  });
  // Nhãn thường ~25mm: gấp đôi mã TikTok. Đọc ở cỡ gốc và ở cỡ dự phòng
  // (khi không dò được camera) đều phải ra mã.
  const native = paintCode(symbol, 2560, 1440, 100);
  assert.equal((await decodeGrayFrame(native, 2560, 1440))[0]?.text, "SPXVN0123456789");
  const fallback = downscale(native, 2560, 1440, QR_FALLBACK_WIDTH, QR_FALLBACK_HEIGHT);
  assert.equal(
    (await decodeGrayFrame(fallback, QR_FALLBACK_WIDTH, QR_FALLBACK_HEIGHT))[0]?.text,
    "SPXVN0123456789",
  );
});

test("cỡ khung bám theo camera, chỉ thu nhỏ khi vượt trần", () => {
  const cap = { width: QR_FRAME_WIDTH, height: QR_FRAME_HEIGHT };
  // Camera 2K: đọc đúng cỡ gốc.
  assert.deepEqual(fitWithinCap({ width: 2560, height: 1440 }, cap), { width: 2560, height: 1440 });
  // Camera Full HD: KHÔNG phóng to lên cho bằng trần — phóng to chỉ tốn CPU.
  assert.deepEqual(fitWithinCap({ width: 1920, height: 1080 }, cap), { width: 1920, height: 1080 });
  // Camera 4K: thu về vừa trần, giữ tỉ lệ.
  assert.deepEqual(fitWithinCap({ width: 3840, height: 2160 }, cap), { width: 2560, height: 1440 });
  // Số đo hỏng: rơi về cỡ dự phòng thay vì dựng khung rỗng.
  assert.deepEqual(fitWithinCap({ width: 0, height: 0 }, cap), {
    width: QR_FALLBACK_WIDTH,
    height: QR_FALLBACK_HEIGHT,
  });
  // Chiều nào cũng phải chẵn — bộ lọc ffmpeg đòi vậy.
  const odd = fitWithinCap({ width: 1281, height: 721 }, { width: 640, height: 640 });
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
});

test("ffmpeg nhận đúng cỡ khung được giao", () => {
  const args = buildQrFrameArgs("cam01m", 10, 2560, 1440).join(" ");
  assert.ok(args.includes("scale=2560:1440:force_original_aspect_ratio=decrease"));
  assert.ok(args.includes("rtsp://127.0.0.1:8554/cam01m"));
  const weak = buildQrFrameArgs("cam01m", 5, 640, 360).join(" ");
  assert.ok(weak.includes("fps=5,scale=640:360"), "máy kho yếu vẫn hạ được cỡ khung");
});

test("ffprobe thật đọc đúng độ phân giải của luồng", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";

  const dir = await mkdtemp(join(tmpdir(), "qr-probe-"));
  const file = join(dir, "sample.mp4");
  const made = await new Promise<boolean>((resolve) => {
    execFile(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", "testsrc=size=2560x1440:rate=10:duration=1", file],
      { timeout: 60_000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
  if (!made) {
    await rm(dir, { recursive: true, force: true });
    t.skip("máy này không có ffmpeg trong PATH");
    return;
  }

  const size = await probeTargetSize(ffprobe, file);
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(size, { width: 2560, height: 1440 });
});
