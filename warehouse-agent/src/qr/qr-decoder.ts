import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  prepareZXingModule,
  readBarcodes,
  type ReadResult,
} from "zxing-wasm";
import type { DecodedQr, QrBox } from "./qr-zone";

let prepared = false;

function prepareLocalWasm(): void {
  if (prepared) return;
  const wasmPath = resolve(
    dirname(require.resolve("zxing-wasm")),
    "..",
    "..",
    "full",
    "zxing_full.wasm",
  );
  const wasm = readFileSync(wasmPath);
  const wasmBinary = wasm.buffer.slice(
    wasm.byteOffset,
    wasm.byteOffset + wasm.byteLength,
  );
  prepareZXingModule({ overrides: { wasmBinary } });
  prepared = true;
}

function boxFromResult(result: ReadResult): QrBox {
  const points = Object.values(result.position);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

function encodePgm(gray: Uint8Array, width: number, height: number): Uint8Array {
  if (gray.byteLength !== width * height) {
    throw new Error(
      `Invalid grayscale frame: got ${gray.byteLength}, expected ${width * height}`,
    );
  }
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii");
  const image = new Uint8Array(header.byteLength + gray.byteLength);
  image.set(header, 0);
  image.set(gray, header.byteLength);
  return image;
}

export async function decodeGrayFrame(
  gray: Uint8Array,
  width: number,
  height: number,
): Promise<DecodedQr[]> {
  prepareLocalWasm();
  const results = await readBarcodes(encodePgm(gray, width, height), {
    formats: ["QRCode"],
    maxNumberOfSymbols: 0,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
  });
  return results
    .filter((result) => result.format === "QRCode" && !result.error && result.text.trim())
    .map((result) => ({ text: result.text, box: boxFromResult(result) }));
}
