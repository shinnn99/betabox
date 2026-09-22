/**
 * Thẻ QR điều khiển dán ở bàn — ĐÃ NGỪNG DÙNG (22/09/2026).
 *
 * Chủ dự án bỏ hẳn thẻ: chuyển chế độ nhận hoàn chỉ còn trên trang Hàng
 * hoàn, không ghi kết quả kiểm bằng thẻ nữa. File này chỉ còn để NHẬN RA
 * thẻ cũ: route quét bỏ qua thẻ (không ghi nhầm thành mã vận đơn) và nhật
 * ký hoạt động vẫn gọi đúng tên các lượt quét thẻ đã có trong lịch sử.
 *
 * Mô tả gốc:
 * Vì sao là thẻ QR chứ không phải nút trên màn hình: nhân viên kho đang cầm
 * súng quét hoặc đứng trước camera, tay bận hàng. Thao tác rẻ nhất với họ là
 * quét thêm một mã. Bàn quét bằng camera cũng dùng được ngay, không cần
 * chạm vào máy.
 *
 * Dạng mã: `BETABOX:<nhóm>:<giá trị>`, chữ hoa, không dấu cách.
 *   BETABOX:MODE:RETURN     → chuyển bàn sang chế độ NHẬN HOÀN
 *   BETABOX:MODE:OUTBOUND   → về chế độ ĐÓNG HÀNG
 *   BETABOX:RESULT:OK       → kiện hoàn: hàng ổn
 *   BETABOX:RESULT:DAMAGED  → hỏng
 *   BETABOX:RESULT:MISSING  → thiếu
 *   BETABOX:RESULT:SWAPPED  → tráo
 *   BETABOX:END             → kết thúc kiện, chưa xác nhận kết quả
 *
 * Tiền tố `BETABOX:` là thứ phân biệt thẻ với mã vận đơn. Mã vận đơn của
 * các sàn không có dấu hai chấm, nên không thể trùng.
 */

export type ControlCard =
  | { kind: "mode"; mode: "outbound" | "return" }
  | { kind: "result"; result: "ok" | "damaged" | "missing" | "swapped" }
  | { kind: "end" };

const PREFIX = "BETABOX:";

const MODES: Record<string, "outbound" | "return"> = {
  OUTBOUND: "outbound",
  RETURN: "return",
};

const RESULTS: Record<string, "ok" | "damaged" | "missing" | "swapped"> = {
  OK: "ok",
  DAMAGED: "damaged",
  MISSING: "missing",
  SWAPPED: "swapped",
};

/**
 * Đọc một lượt quét thành thẻ điều khiển.
 *
 * Trả `null` nghĩa là "không phải thẻ" — lượt quét đi tiếp theo đường cũ
 * (QR nhân viên hoặc mã vận đơn). Thẻ sai giá trị (`BETABOX:MODE:XYZ`) cũng
 * trả `null` để không âm thầm làm việc khác ý người quét; tầng gọi sẽ ghi
 * nhận là mã không hợp lệ.
 */
export function parseControlCard(rawValue: string): ControlCard | null {
  const value = rawValue.trim().toUpperCase();
  if (!value.startsWith(PREFIX)) return null;

  const body = value.slice(PREFIX.length);
  if (body === "END") return { kind: "end" };

  const sep = body.indexOf(":");
  if (sep <= 0) return null;
  const group = body.slice(0, sep);
  const arg = body.slice(sep + 1);

  if (group === "MODE") {
    const mode = MODES[arg];
    return mode ? { kind: "mode", mode } : null;
  }
  if (group === "RESULT") {
    const result = RESULTS[arg];
    return result ? { kind: "result", result } : null;
  }
  return null;
}

/** Lượt quét có dạng thẻ điều khiển (kể cả thẻ sai giá trị). */
export function looksLikeControlCard(rawValue: string): boolean {
  return rawValue.trim().toUpperCase().startsWith(PREFIX);
}
