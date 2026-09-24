import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  prepareZXingModule,
  readBarcodes,
  type ReadResult,
} from "zxing-wasm";
import type { CodeCandidate } from "./code-pick";
import type { QrBox } from "./qr-zone";

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

/**
 * Các định dạng agent chịu đọc.
 *
 * QR + DataMatrix là mã hai chiều; phần còn lại là mã vạch một chiều. Mở
 * mã vạch theo yêu cầu chủ dự án 24/09/2026: "đôi khi QR bé nhưng barcode
 * vẫn rõ ràng hơn" — mã vạch dài ngang nên giữ được chi tiết ở xa tốt hơn
 * một QR nhỏ xíu. Nhãn vận đơn Việt Nam hầu hết dùng Code128.
 *
 * Không mở EAN/UPC: đó là mã SẢN PHẨM in trên hộp, đọc trúng là tạo đơn
 * bằng mã hàng hoá.
 */
const TWO_DIMENSIONAL = new Set(["QRCode", "MicroQRCode", "rMQRCode", "DataMatrix"]);
const ONE_DIMENSIONAL = new Set(["Code128", "Code39", "Code93", "ITF", "Codabar"]);

export async function decodeGrayFrame(
  gray: Uint8Array,
  width: number,
  height: number,
): Promise<CodeCandidate[]> {
  prepareLocalWasm();
  const results = await readBarcodes(encodePgm(gray, width, height), {
    formats: [...TWO_DIMENSIONAL, ...ONE_DIMENSIONAL] as never,
    maxNumberOfSymbols: 0,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDenoise: true,
  });
  return results
    .filter(
      (result) =>
        !result.error &&
        result.text.trim() &&
        (TWO_DIMENSIONAL.has(result.format) || ONE_DIMENSIONAL.has(result.format)),
    )
    .map((result) => ({
      text: result.text,
      box: boxFromResult(result),
      kind: TWO_DIMENSIONAL.has(result.format) ? ("qr" as const) : ("barcode" as const),
    }));
}
