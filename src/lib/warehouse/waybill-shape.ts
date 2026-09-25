/**
 * Chuỗi này có dáng một mã vận đơn không?
 *
 * Bản sao của hàm `is_waybill_like` trên database (migration
 * 20260925100000). Hai nơi phải khớp nhau: database là chốt chặn cuối,
 * còn đây là chốt chặn ở cửa — chuỗi rớt luật thì KHÔNG ghi vào database
 * chút nào, kể cả lượt quét thô.
 *
 * Vì sao không ghi: chủ dự án chốt 25/09/2026 — "những cái đơn mã sai tôi
 * đã bảo không nhận cũng không lưu vào database mà". Bản 25/09 đầu tiên
 * chỉ chặn ở mức không tạo đơn, nhưng lượt quét vẫn nằm lại và hiện thành
 * dòng "Mã sai" / "Đang chờ xử lý" trong nhật ký đóng hàng.
 *
 * Luật cố tình để RỘNG (thà nhận nhầm còn hơn chặn nhầm đơn thật):
 *   - dài 8–40 ký tự
 *   - chỉ gồm chữ, số, và `-` `_` `.`
 *   - bắt đầu bằng chữ hoặc số
 *
 * Mã thật của các sàn đều qua: 862487244176, 260924UUVC54EF,
 * SPXVN060122245929, TTVN1111790805. Đường link rớt ngay vì có `://`.
 *
 * Đổi luật ở đây thì phải đổi cả migration, và ngược lại —
 * `tests/waybill-shape-guard.test.ts` giữ cho hai bên không lệch nhau.
 */
export const WAYBILL_MIN_LENGTH = 8;
export const WAYBILL_MAX_LENGTH = 40;
const WAYBILL_SHAPE = /^[A-Z0-9][A-Z0-9._-]*$/;

/** Chuẩn hoá đúng như database: `upper(trim(raw_value))`. */
export function toWaybillCandidate(rawValue: string): string {
  return rawValue.trim().toUpperCase();
}

export function isWaybillLike(value: string): boolean {
  if (value.length < WAYBILL_MIN_LENGTH || value.length > WAYBILL_MAX_LENGTH) return false;
  return WAYBILL_SHAPE.test(value);
}
