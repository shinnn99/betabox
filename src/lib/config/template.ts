/**
 * Mẫu cấu hình nền tảng — phần thuần (kế hoạch VAN-HANH-NHIEU-KHO, đợt 6).
 * Đọc từ DB ở `template-store.ts`; bảng ở migration 20260926120000.
 *
 * Hai loại giá trị trong mẫu, dùng theo hai cách KHÁC nhau:
 *
 *   - Giá trị tổ chức / kho: CHÉP LÚC TẠO. Sửa mẫu không đổi tổ chức nào
 *     đang có — áp cho tổ chức cũ là thao tác có người bấm, chỉ điền ô trống.
 *   - `clip_max_seconds`: LAN CAN ĐỌC LÚC CHẠY — trần clip bằng chứng và trần
 *     tự dừng đơn đi của cả nền tảng.
 *
 * Hàm thuần, không đụng DB — dùng được ở client, server và test.
 */
import { ORDER_HARD_LIMIT_SECONDS } from "@/lib/station/order-timeout";
import { MAX_CLIP_DURATION_SECONDS } from "@/lib/order-proof/clip-window";
import { FALLBACK_DEFAULT_POST, FALLBACK_PRE } from "@/lib/order-proof/timing-config";
import { DEFAULT_RETURN_RETENTION_DAYS } from "@/lib/config/return-retention";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, TIMING_EDIT_BOUNDS } from "@/lib/config/validate";

export interface PlatformTemplate {
  retention_days: number;
  return_retention_days: number;
  max_order_seconds: number;
  video_pre_seconds: number;
  video_default_post_seconds: number;
  session_fallback_seconds: number;
  clip_max_seconds: number;
}

export type TemplateKey = keyof PlatformTemplate;

/**
 * Trần an toàn của `clip_max_seconds`. Clip ghép hai góc nén lại ở 3200 kbps
 * (agent `clip-composer.ts`), agent từ chối tải lên file trên 90 MiB:
 * 90 MiB × 8 / 3,2 Mbps ≈ 235 s, chừa 10% → 210 s. Nới tiếp chỉ sau khi agent
 * tự hạ bitrate cho clip dài (đợt 7). Khớp CHECK trong migration.
 */
export const CLIP_MAX_SAFE_SECONDS = 210;
export const CLIP_MAX_MIN_SECONDS = 60;

/**
 * Dùng khi chưa có bảng mẫu (chưa chạy migration) hoặc đọc lỗi. BẰNG ĐÚNG
 * mặc định đang chạy trong mã — mất bảng mẫu không được đổi hành vi kho nào.
 * `retention_days`: mã không có mặc định (trống = không dọn); 30 là giá trị
 * cả hai tổ chức hiện có đang dùng, và là giá trị ban đầu của migration.
 */
export const TEMPLATE_FALLBACK: PlatformTemplate = {
  retention_days: 30,
  return_retention_days: DEFAULT_RETURN_RETENTION_DAYS,
  max_order_seconds: ORDER_HARD_LIMIT_SECONDS,
  video_pre_seconds: FALLBACK_PRE,
  video_default_post_seconds: FALLBACK_DEFAULT_POST,
  session_fallback_seconds: 30,
  clip_max_seconds: MAX_CLIP_DURATION_SECONDS,
};

/** Khoảng nhận của từng ô — cùng khoảng với route tenant, cộng lan can clip. */
export const TEMPLATE_BOUNDS: Record<TemplateKey, { min: number; max: number }> = {
  retention_days: { min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS },
  return_retention_days: { min: RETENTION_MIN_DAYS, max: RETENTION_MAX_DAYS },
  max_order_seconds: TIMING_EDIT_BOUNDS.max_order_seconds,
  video_pre_seconds: TIMING_EDIT_BOUNDS.video_pre_seconds,
  video_default_post_seconds: TIMING_EDIT_BOUNDS.video_default_post_seconds,
  session_fallback_seconds: { min: 1, max: 3600 },
  clip_max_seconds: { min: CLIP_MAX_MIN_SECONDS, max: CLIP_MAX_SAFE_SECONDS },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATE_BOUNDS) as TemplateKey[];

/**
 * Vá mẫu từ body. KHÁC route tenant: ngoài khoảng là TỪ CHỐI, không kẹp —
 * mẫu áp cho mọi tổ chức mới, gõ nhầm mà được kẹp âm thầm thì không ai biết.
 */
export function parseTemplatePatch(
  body: unknown,
): { ok: true; update: Partial<PlatformTemplate> } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "Thân yêu cầu không hợp lệ." };
  const src = body as Record<string, unknown>;
  const update: Partial<PlatformTemplate> = {};
  for (const key of TEMPLATE_KEYS) {
    if (!(key in src)) continue;
    const v = src[key];
    const { min, max } = TEMPLATE_BOUNDS[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      const why =
        key === "clip_max_seconds"
          ? ` Trên ${CLIP_MAX_SAFE_SECONDS}s thì clip vượt ngưỡng tải lên 90 MiB của agent và bị từ chối.`
          : "";
      return { ok: false, message: `${key} phải là số nguyên trong khoảng ${min}–${max}.${why}` };
    }
    update[key] = v;
  }
  if (Object.keys(update).length === 0) return { ok: false, message: "Không có ô nào để sửa." };
  return { ok: true, update };
}

/** Đọc một dòng DB thành mẫu; ô nào hỏng thì lấy giá trị dự phòng. */
export function templateFromRow(row: Record<string, unknown> | null | undefined): PlatformTemplate {
  const out = { ...TEMPLATE_FALLBACK };
  if (!row) return out;
  for (const key of TEMPLATE_KEYS) {
    const v = Number(row[key]);
    const { min, max } = TEMPLATE_BOUNDS[key];
    if (Number.isInteger(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}

/** Cột tổ chức chép từ mẫu lúc tạo. */
export function orgFieldsFromTemplate(t: PlatformTemplate) {
  return { retention_days: t.retention_days, return_retention_days: t.return_retention_days };
}

/** Ba ô thời gian chép vào JSON cấu hình kho — GỘP vào mặc định của DB, không thay. */
export function warehouseTimingFromTemplate(t: PlatformTemplate) {
  return {
    max_order_seconds: t.max_order_seconds,
    video_pre_seconds: t.video_pre_seconds,
    video_default_post_seconds: t.video_default_post_seconds,
  };
}

// ============================================================================
// "Điền mẫu vào ô trống" cho tổ chức đang có
// ============================================================================

export interface BlankFillPlan {
  org: Partial<Record<"retention_days" | "return_retention_days", number>>;
  warehouses: Array<{
    id: string;
    code: string | null;
    timing: Partial<Record<"max_order_seconds" | "video_pre_seconds" | "video_default_post_seconds", number>>;
    session_fallback_seconds?: number;
  }>;
}

const blank = (v: unknown) => v === null || v === undefined;

/**
 * Ô nào ĐANG TRỐNG thì điền giá trị mẫu. Ô đã đặt — kể cả đặt lệch mẫu —
 * không bao giờ bị đụng: đó là quyết định của người đặt. Hàm thuần.
 */
export function planBlankFill(
  org: { retention_days: number | null; return_retention_days: number | null },
  warehouses: Array<{
    id: string;
    code: string | null;
    packing_timing_config: unknown;
    session_fallback_seconds: number | null;
  }>,
  t: PlatformTemplate,
): BlankFillPlan {
  const plan: BlankFillPlan = { org: {}, warehouses: [] };
  if (blank(org.retention_days)) plan.org.retention_days = t.retention_days;
  if (blank(org.return_retention_days)) plan.org.return_retention_days = t.return_retention_days;

  const timing = warehouseTimingFromTemplate(t);
  for (const w of warehouses) {
    const cfg = (w.packing_timing_config && typeof w.packing_timing_config === "object"
      ? w.packing_timing_config
      : {}) as Record<string, unknown>;
    const fill: BlankFillPlan["warehouses"][number] = { id: w.id, code: w.code, timing: {} };
    for (const key of Object.keys(timing) as Array<keyof typeof timing>) {
      if (blank(cfg[key])) fill.timing[key] = timing[key];
    }
    if (blank(w.session_fallback_seconds)) fill.session_fallback_seconds = t.session_fallback_seconds;
    if (Object.keys(fill.timing).length > 0 || fill.session_fallback_seconds !== undefined) {
      plan.warehouses.push(fill);
    }
  }
  return plan;
}

export function planIsEmpty(plan: BlankFillPlan): boolean {
  return Object.keys(plan.org).length === 0 && plan.warehouses.length === 0;
}
