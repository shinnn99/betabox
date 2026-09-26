/**
 * Luật kiểm giá trị cấu hình — MỘT bộ cho cả hai đường sửa:
 *
 *   - tenant: `PATCH /api/organization`, `PATCH /api/warehouses/[id]`
 *   - platform: `PATCH /api/platform/orgs/[id]/config`,
 *               `PATCH /api/platform/orgs/[id]/warehouses/[warehouseId]/config`
 *
 * Tách ra ngày 26/09/2026 (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4). Trước đó luật
 * nằm lọt trong route tenant; route platform mà chép lại thì hai đường sửa
 * sẽ trôi khỏi nhau — đúng kiểu "mỗi nơi tự kẹp một kiểu" mà phép giải
 * Đặt / Thực dùng (`effective.ts`) sinh ra để dọn.
 *
 * Hàm thuần, không đụng DB.
 */

// Retention hợp lệ: 7-365 ngày. Dưới 7 = mất bằng chứng ngay; trên 365 = ổ đầy
// vô ích (không sàn nào cho khiếu nại quá năm). DB CHECK constraint enforce
// cùng range — validate ở đây trả lỗi rõ tiếng Việt trước khi DB reject.
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 365;

export const RETENTION_FIELDS = ["retention_days", "return_retention_days"] as const;
export type RetentionField = (typeof RETENTION_FIELDS)[number];

/**
 * Lỗi của một ô hạn lưu, `null` nếu hợp lệ. `null` là giá trị hợp lệ — bỏ
 * cấu hình: resolver trả nhãn trung tính, script dọn ổ fail-loud → người
 * vận hành biết là chưa cấu hình.
 */
export function retentionFieldError(field: RetentionField, v: unknown): string | null {
  if (v === null) return null;
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < RETENTION_MIN_DAYS ||
    v > RETENTION_MAX_DAYS
  ) {
    return `${field} phải là số nguyên trong khoảng ${RETENTION_MIN_DAYS}-${RETENTION_MAX_DAYS} ngày (hoặc null để bỏ cấu hình).`;
  }
  return null;
}

/** Khoảng nhận của ba ô thời gian sửa được — cùng cận với clip-resolver. */
export const TIMING_EDIT_BOUNDS = {
  max_order_seconds: { min: 60, max: 3600 },
  video_pre_seconds: { min: 0, max: 120 },
  video_default_post_seconds: { min: 1, max: 600 },
} as const;
export type TimingEditKey = keyof typeof TIMING_EDIT_BOUNDS;

/**
 * packing_timing_config: chỉ nhận 3 field UI, kẹp theo ngưỡng an toàn (cùng
 * cận với clip-resolver để config không tạo clip vượt trần cứng). Trả phần
 * vá để merge vào JSONB — giữ nguyên các key khác (kỹ thuật, không mở UI).
 * `null` khi không có ô nào dùng được.
 */
export function buildTimingPatch(input: unknown): Partial<Record<TimingEditKey, number>> | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;
  const patch: Partial<Record<TimingEditKey, number>> = {};
  for (const key of Object.keys(TIMING_EDIT_BOUNDS) as TimingEditKey[]) {
    const v = src[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const { min, max } = TIMING_EDIT_BOUNDS[key];
    patch[key] = Math.min(max, Math.max(min, Math.floor(v)));
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** `session_fallback_seconds`: số dương, làm tròn xuống; khác đi thì bỏ qua. */
export function sessionFallbackFrom(v: unknown): number | null {
  return typeof v === "number" && v > 0 ? Math.floor(v) : null;
}
