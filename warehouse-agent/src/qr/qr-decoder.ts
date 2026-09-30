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

const ALL_FORMATS = [...TWO_DIMENSIONAL, ...ONE_DIMENSIONAL];

/**
 * Định dạng của pha NHANH: những gì thực sự in trên nhãn vận đơn Việt Nam.
 *
 * QR và Code128 phủ gần hết; DataMatrix thỉnh thoảng gặp. Bốn loại còn lại
 * (Code39/Code93/ITF/Codabar) hiếm tới mức không đáng quét trên MỌI khung —
 * pha kỹ vẫn tìm chúng.
 */
const FAST_FORMATS = ["QRCode", "DataMatrix", "Code128"];

/**
 * Hai pha — vì sao.
 *
 * Đo 30/09/2026 trên khung 1920x1080 xám, camera 2K của kho: quét đủ 9 định
 * dạng với đủ bốn cờ `try*` mất 166ms mỗi khung ở 2560x1440. Ngân sách chỉ
 * có 100ms (10 khung/giây), nên `decoderBusy` ở qr-scan-service vứt 2 trong
 * 3 khung. Mà qr-zone đòi HAI khung liên tiếp cùng đọc ra một mã mới phát
 * lượt quét — nên nhân viên phải giơ nhãn đứng yên chờ, đúng triệu chứng
 * "quét mãi không ăn" chủ dự án báo.
 *
 * Gốc của chi phí KHÔNG phải mã vạch (2.3x) mà là cỡ khung (15x) cộng hai
 * cờ `tryHarder`/`tryDenoise` — mỗi cờ ăn ~45% thời gian. Nhưng bỏ hẳn
 * chúng thì mất mã nhỏ (nhãn TikTok 12mm), đúng lỗi mà 2a57b63 sinh ra để
 * sửa. Nên không bỏ, mà HOÃN:
 *
 *   Pha nhanh (16ms): ít định dạng, không cờ nào. Nhãn giơ ngay ngắn —
 *     tuyệt đại đa số trường hợp — là trúng ngay tại đây.
 *   Pha kỹ (166ms): đủ định dạng, đủ cờ. CHỈ chạy khi pha nhanh trắng tay.
 *
 * Khung trống chiếm ~99% thời gian nhưng lại là khung ĐẮT nhất (không có
 * mã thì bộ giải mã phải quét cạn ảnh mới dám kết luận). Vì vậy pha kỹ vẫn
 * phải bị chặn tần suất, xem `slowPhaseDue` bên dưới — nếu không thì mỗi
 * khung trống lại trả đủ giá 166ms và ta không sửa được gì.
 */
const FAST: Record<string, boolean> = {
  tryHarder: false,
  tryRotate: false,
  tryInvert: false,
  tryDenoise: false,
};
const THOROUGH: Record<string, boolean> = {
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDenoise: true,
};

/**
 * Giãn cách tối thiểu giữa hai lần chạy pha kỹ, mỗi camera.
 *
 * Mã nhỏ/mờ/nghiêng nằm yên trước ống kính lâu hơn nhiều so với con số này,
 * nên hoãn pha kỹ không làm mất mã — chỉ làm nó được tìm thấy chậm hơn vài
 * trăm mili giây. Đổi lại, khung trống không còn đốt 166ms mỗi lần.
 */
const SLOW_PHASE_INTERVAL_MS = 500;

/** Lần cuối chạy pha kỹ, theo camera. Khoá rỗng = đường gọi không nêu camera. */
const lastSlowPhaseAt = new Map<string, number>();

/** Pha kỹ tới lượt chưa? Không nêu camera thì luôn cho chạy (test, testDecode). */
function slowPhaseDue(cameraKey: string | undefined, now: number): boolean {
  if (!cameraKey) return true;
  const previous = lastSlowPhaseAt.get(cameraKey);
  return previous === undefined || now - previous >= SLOW_PHASE_INTERVAL_MS;
}

/** Quên trạng thái hoãn của một camera — gọi khi ngừng đọc camera đó. */
export function forgetDecoderState(cameraKey: string): void {
  lastSlowPhaseAt.delete(cameraKey);
  slowPhaseRuns.delete(cameraKey);
}

/**
 * Đếm số lần pha kỹ thực sự chạy, theo camera.
 *
 * Chỉ để TEST canh đúng thứ cần canh. Bài test tốc độ từng đo bằng đồng hồ
 * và đỏ ngẫu nhiên: trình chạy test của Node mở song song nhiều file trên
 * 8 lõi nên con số đo được là tải máy, không phải chi phí giải mã — kể cả
 * khi so tương đối giữa các lần trong cùng bài. Đếm số lần chạy thì tất
 * định, không phụ thuộc máy nhanh hay chậm.
 */
const slowPhaseRuns = new Map<string, number>();

/** Pha kỹ đã chạy bao nhiêu lần cho camera này. */
export function slowPhaseRunCount(cameraKey: string): number {
  return slowPhaseRuns.get(cameraKey) ?? 0;
}

function toCandidates(results: readonly ReadResult[]): CodeCandidate[] {
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

export async function decodeGrayFrame(
  gray: Uint8Array,
  width: number,
  height: number,
  /**
   * Khoá để hoãn pha kỹ riêng cho từng camera. Bỏ trống thì không hoãn —
   * giữ nguyên hành vi cũ cho test và cho lệnh thử giải mã.
   */
  cameraKey?: string,
): Promise<CodeCandidate[]> {
  prepareLocalWasm();
  const image = encodePgm(gray, width, height);

  const fast = toCandidates(
    await readBarcodes(image, {
      formats: FAST_FORMATS as never,
      maxNumberOfSymbols: 0,
      ...FAST,
    }),
  );
  if (fast.length > 0) return fast;

  if (!slowPhaseDue(cameraKey, Date.now())) return [];
  if (cameraKey) {
    slowPhaseRuns.set(cameraKey, (slowPhaseRuns.get(cameraKey) ?? 0) + 1);
  }

  try {
    return toCandidates(
      await readBarcodes(image, {
        formats: ALL_FORMATS as never,
        maxNumberOfSymbols: 0,
        ...THOROUGH,
      }),
    );
  } finally {
    // Đóng mốc SAU khi pha kỹ chạy xong, không phải trước.
    //
    // Đóng mốc trước thì khoảng hoãn tính từ lúc BẮT ĐẦU, nên khi pha kỹ
    // chạy lâu hơn 500ms — đúng lúc máy yếu hoặc đang bận, tức đúng lúc
    // cần hoãn nhất — khung kế tiếp đã thấy mốc hết hạn và lại chạy pha
    // kỹ. Cơ chế hoãn tự tắt ngầm, không ai biết. Bắt được nhờ bài test
    // đếm số lần chạy: 6 khung liên tiếp ra 6 lần thay vì 1.
    //
    // Đóng mốc sau thì 500ms luôn là khoảng NGHỈ thật giữa hai pha kỹ.
    // Đặt trong `finally` để lỗi giải mã cũng không làm kẹt vòng hoãn.
    if (cameraKey) lastSlowPhaseAt.set(cameraKey, Date.now());
  }
}
