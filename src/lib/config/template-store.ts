import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/system/job-log";
import { TEMPLATE_FALLBACK, templateFromRow, type PlatformTemplate } from "@/lib/config/template";

/**
 * Đọc mẫu cấu hình nền tảng từ DB (kế hoạch VAN-HANH-NHIEU-KHO, đợt 6).
 *
 * KHÔNG BAO GIỜ NÉM, KHÔNG BAO GIỜ TRẢ Ô TRỐNG. Chưa có bảng (chưa chạy
 * migration 20260926120000), mạng chập, dòng hỏng → trả `TEMPLATE_FALLBACK`,
 * bằng đúng mặc định đang chạy trong mã. Một tính năng phụ (mẫu sửa được)
 * không được làm gãy nghiệp vụ chính (tạo kho, cắt clip, tự dừng đơn).
 *
 * Đệm 60 giây: trần clip được đọc ở đường cắt clip và đường tự dừng đơn —
 * mỗi lượt một truy vấn là phí. Sửa mẫu qua API thì xoá đệm ngay.
 */

type Admin = ReturnType<typeof createAdminClient>;

export interface TemplateRead {
  template: PlatformTemplate;
  /** false = đang dùng giá trị dự phòng trong mã, không phải bảng mẫu. */
  fromTable: boolean;
  reason: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

const TTL_MS = 60_000;
let cache: { value: TemplateRead; at: number } | null = null;

export function invalidateTemplateCache(): void {
  cache = null;
}

export async function readPlatformTemplate(
  admin?: Admin,
  opts: { fresh?: boolean } = {},
): Promise<TemplateRead> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: TemplateRead;
  try {
    const client = admin ?? createAdminClient();
    const { data, error } = await client
      .from("platform_config_template")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      const code = (error as { code?: string }).code;
      const missing = code === "42P01" || code === "PGRST205";
      value = fallback(
        missing
          ? "Chưa có bảng mẫu — cần chạy migration 20260926120000. Đang dùng mặc định trong mã."
          : `Không đọc được bảng mẫu: ${error.message}. Đang dùng mặc định trong mã.`,
      );
    } else if (data) {
      const row = data as Record<string, unknown>;
      value = {
        template: templateFromRow(row),
        fromTable: true,
        reason: null,
        updated_at: (row.updated_at as string | null) ?? null,
        updated_by: (row.updated_by as string | null) ?? null,
      };
    } else {
      value = fallback("Bảng mẫu chưa có dòng nào. Đang dùng mặc định trong mã.");
    }
  } catch (err) {
    value = fallback(`Không đọc được bảng mẫu: ${errorMessage(err)}. Đang dùng mặc định trong mã.`);
  }
  // Đệm cả kết quả dự phòng: bảng chưa có thì 60 giây sau mới hỏi lại, không
  // phải mỗi lượt cắt clip một lần hỏi hụt.
  cache = { value, at: Date.now() };
  return value;
}

function fallback(reason: string): TemplateRead {
  return { template: { ...TEMPLATE_FALLBACK }, fromTable: false, reason, updated_at: null, updated_by: null };
}

/** Trần clip bằng chứng = trần tự dừng đơn đi của cả nền tảng. */
export async function getClipMaxSeconds(admin?: Admin): Promise<number> {
  return (await readPlatformTemplate(admin)).template.clip_max_seconds;
}

// ============================================================================
// Chép mẫu LÚC TẠO — tổ chức mới, kho mới.
// ============================================================================

/** Hai ô hạn lưu cho tổ chức mới. Không bao giờ ném; mẫu hỏng → mặc định trong mã. */
export async function orgFieldsForNewOrg(admin: Admin): Promise<{ retention_days: number; return_retention_days: number }> {
  const t = (await readPlatformTemplate(admin)).template;
  return { retention_days: t.retention_days, return_retention_days: t.return_retention_days };
}

/**
 * Gộp mẫu vào kho VỪA TẠO: ba ô thời gian gộp vào JSON mặc định của DB (giữ
 * nguyên 13 khoá kỹ thuật còn lại), cộng `session_fallback_seconds`.
 *
 * Không bao giờ ném: hỏng thì kho vẫn đã tạo xong với mặc định của DB — bằng
 * đúng mẫu ban đầu. Trả câu lỗi để route ghi log.
 */
export async function seedNewWarehouse(
  admin: Admin,
  warehouse: { id: string; organization_id: string; packing_timing_config: unknown },
): Promise<string | null> {
  try {
    const t = (await readPlatformTemplate(admin)).template;
    const cur = (warehouse.packing_timing_config as Record<string, unknown> | null) ?? {};
    const { error } = await admin
      .from("warehouses")
      .update({
        packing_timing_config: {
          ...cur,
          max_order_seconds: t.max_order_seconds,
          video_pre_seconds: t.video_pre_seconds,
          video_default_post_seconds: t.video_default_post_seconds,
        },
        session_fallback_seconds: t.session_fallback_seconds,
      })
      .eq("id", warehouse.id)
      .eq("organization_id", warehouse.organization_id);
    return error ? error.message : null;
  } catch (err) {
    return errorMessage(err);
  }
}
