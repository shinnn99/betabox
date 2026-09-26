/**
 * Số ngày giữ đoạn video thuần hàng hoàn — MỘT nơi tính.
 *
 * Trước 26/09/2026 phép tính này nằm lọt thỏm trong route
 * `/api/agent/retention-plan`. Phép giải "Đặt / Thực dùng" muốn hiện đúng
 * con số máy kho đang dùng thì phải gọi cùng hàm, không được chép lại —
 * chép lại là thêm một nơi tự tính, đúng thứ đang đi dọn.
 *
 * Thứ tự ưu tiên (giữ nguyên hành vi của route):
 *   1. `organizations.return_retention_days` — ô trên trang Cấu hình kho,
 *      thêm ngày 23/09/2026.
 *   2. `packing_timing_config.return_segment_retention_days` của kho — chỗ
 *      cũ, từ trước khi có ô cấp tổ chức.
 *   3. Mặc định 7 ngày.
 *
 * Giá trị ngoài 1–365 bị bỏ qua và rơi về mặc định.
 */

export const DEFAULT_RETURN_RETENTION_DAYS = 7;

export interface ReturnRetention {
  days: number;
  /** Con số này lấy từ đâu — để phép giải nói được "vì sao". */
  source: "org" | "warehouse_legacy" | "default";
}

export function resolveReturnRetentionDays(
  orgValue: unknown,
  warehouseCfg: unknown,
): ReturnRetention {
  const inRange = (n: number) => Number.isFinite(n) && n >= 1 && n <= 365;

  const orgDays = Number(orgValue);
  if (Number.isFinite(orgDays) && orgDays > 0) {
    // Tổ chức đã đặt thì KHÔNG rơi xuống cấu hình kho, kể cả khi giá trị
    // ngoài khoảng — đúng như route cũ: ô tổ chức thắng, sai thì về mặc định.
    return inRange(orgDays)
      ? { days: Math.floor(orgDays), source: "org" }
      : { days: DEFAULT_RETURN_RETENTION_DAYS, source: "default" };
  }

  const cfg =
    warehouseCfg && typeof warehouseCfg === "object"
      ? (warehouseCfg as Record<string, unknown>)
      : null;
  const legacy = Number(cfg?.return_segment_retention_days);
  if (inRange(legacy)) return { days: Math.floor(legacy), source: "warehouse_legacy" };

  return { days: DEFAULT_RETURN_RETENTION_DAYS, source: "default" };
}
