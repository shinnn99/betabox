import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  prepareZXingModule as prepareWriterModule,
  writeBarcode,
} from "zxing-wasm/writer";
import { decodeGrayFrame } from "../src/qr/qr-decoder";
import { buildQrFrameArgs } from "../src/qr/qr-frame-source";

test("QR decoder loads bundled WASM and accepts a grayscale PGM frame", async () => {
  const width = 64;
  const height = 64;
  const blank = new Uint8Array(width * height).fill(255);
  assert.deepEqual(await decodeGrayFrame(blank, width, height), []);
});

test("QR decoder rejects malformed frame length", async () => {
  await assert.rejects(() => decodeGrayFrame(new Uint8Array(10), 64, 64), /Invalid grayscale frame/);
});

test("QR decoder reads a real generated QR grayscale frame", async () => {
  const wasm = readFileSync(require.resolve("zxing-wasm/writer/zxing_writer.wasm"));
  prepareWriterModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
  });
  const text = "SPXVN0123456789";
  const generated = await writeBarcode(text, {
    format: "QRCode",
    scale: 4,
    addQuietZones: true,
  });
  const decoded = await decodeGrayFrame(
    generated.symbol.data,
    generated.symbol.width,
    generated.symbol.height,
  );
  assert.equal(decoded[0]?.text, text);
  assert.ok((decoded[0]?.box.width ?? 0) > 0);
});

test("frame source reads localhost relay at configured FPS", () => {
  // Cỡ khung mặc định ở đây là cỡ DỰ PHÒNG (khi không dò được camera);
  // đường chạy thật truyền cỡ thật vào — xem qr-small-code.test.ts.
  const args = buildQrFrameArgs("cam01sub", 10);
  assert.ok(args.includes("rtsp://127.0.0.1:8554/cam01sub"));
  assert.ok(args.includes("fps=10,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=gray"));
  assert.throws(() => buildQrFrameArgs("../camera", 10), /Invalid QR relay path/);
});
