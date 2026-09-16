import { vnParts } from "@/lib/time/vietnam";

/**
 * Tên file video bằng chứng khi giao cho khách: `<mã vận đơn>-<ngày>-<giờ>.mp4`.
 *
 * Vì sao cần hàm riêng: file này đi ra khỏi hệ thống — khách tải về, lưu
 * vào máy họ, có khi gửi tiếp cho bên thứ ba. Tên file là thứ duy nhất đi
 * kèm, nên nó phải tự giải thích được "clip này của đơn nào, quay lúc nào"
 * mà không cần mở hệ thống ra tra. `bucket_path` bên trong Storage vẫn giữ
 * nguyên dạng `org/pe_id/clip_id.mp4` để không phá các row cũ — tên đẹp chỉ
 * áp ở lớp tải xuống.
 *
 * Mốc thời gian lấy theo `packing_events.scanned_at` (lúc quét mã, tức lúc
 * bắt đầu đóng đơn) và đổi sang giờ Việt Nam. KHÔNG dùng giờ tạo clip: hai
 * lần sinh lại clip cho cùng một đơn phải ra cùng một tên, nếu không khách
 * sẽ có hai file trông như hai đơn khác nhau.
 *
 * Định dạng ngày `yyyyMMdd-HHmmss` (không phải dd/MM) để sắp xếp theo tên
 * trong thư mục cũng là sắp xếp theo thời gian.
 */

/** Ký tự an toàn cho tên file trên Windows, macOS và header HTTP. */
const UNSAFE_CHARS = /[^A-Za-z0-9._-]+/g;

/** Trần độ dài phần mã vận đơn, phòng mã rác dài bất thường. */
const MAX_WAYBILL_LENGTH = 64;

export function sanitizeWaybillForFileName(waybillCode: string | null | undefined): string {
  const cleaned = (waybillCode ?? "")
    .trim()
    .replace(UNSAFE_CHARS, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_WAYBILL_LENGTH);
  // Đơn không đọc được mã vẫn phải có file tải về được, không để tên rỗng.
  return cleaned || "don-khong-ma";
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

export function buildProofClipFileName(input: {
  waybillCode: string | null | undefined;
  /** `packing_events.scanned_at`. */
  scannedAt: string | number | Date | null | undefined;
}): string {
  const waybill = sanitizeWaybillForFileName(input.waybillCode);
  const parts = input.scannedAt != null ? vnParts(input.scannedAt) : null;
  if (!parts) {
    // Row hỏng thời gian: vẫn trả tên hợp lệ, có mã đơn để tra cứu được.
    return `${waybill}.mp4`;
  }
  const day = `${parts.year}${pad(parts.month, 2)}${pad(parts.day, 2)}`;
  const time = `${pad(parts.hour, 2)}${pad(parts.minute, 2)}${pad(parts.second, 2)}`;
  return `${waybill}-${day}-${time}.mp4`;
}
