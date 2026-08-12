import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Ghi sổ chạy job nền vào bảng `system_jobs`.
 *
 * Vì sao tồn tại: cron dọn clip từng chết âm thầm 5 ngày sau khi chuyển
 * Vercel → VPS. Không có sổ nào ghi "job chạy lần cuối lúc nào" nên không
 * có gì để cảnh báo dựa vào. Từ đây mọi job nền ghi đúng 1 dòng mỗi lần
 * chạy — thành công lẫn thất bại — và cảnh báo đọc dòng gần nhất.
 *
 * HỢP ĐỒNG QUAN TRỌNG: hàm này KHÔNG BAO GIỜ throw.
 * Việc ghi sổ là quan sát, không phải công việc. Nếu ghi sổ làm hỏng job
 * thật thì nó gây ra đúng loại sự cố mà nó sinh ra để phát hiện. Ghi hỏng
 * → log ra stderr (journalctl trên VPS đọc được) + trả false, để caller
 * đi tiếp.
 */

/** job_name cố định — cảnh báo giai đoạn 2 query đúng chuỗi này. */
export const SYSTEM_JOB_CLEANUP_CLIPS = "cleanup-clips";

export interface SystemJobEntry {
  jobName: string;
  ok: boolean;
  /** Thời gian chạy tính bằng ms. Bỏ trống nếu không đo được. */
  durationMs?: number;
  /**
   * Số liệu tóm tắt lần chạy.
   *
   * CHỈ số đếm / mã lỗi / mốc thời gian. KHÔNG mã đơn, đường dẫn file,
   * tên nhân viên — `system_jobs` là bảng platform-global không có
   * organization_id, không có đường lọc org nào để giới hạn ai đọc được
   * gì. Xem đầu file migration 20260812103000_system_jobs.sql.
   */
  detail?: Record<string, unknown>;
}

export interface RecordJobOptions {
  /**
   * Admin client tiêm vào — chỉ dùng cho test. Bỏ trống thì tự tạo.
   * Cùng nếp với `cleanupExpiredClips({ client })`: phụ thuộc DB nói ra ở
   * chữ ký thay vì giấu trong thân hàm.
   */
  client?: ReturnType<typeof createAdminClient>;
}

/** Cắt ngắn thông điệp lỗi: sổ chạy job không phải nơi lưu stack trace. */
export function truncateForDetail(message: string, max = 500): string {
  return message.length <= max ? message : `${message.slice(0, max)}…`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return truncateForDetail(err.message);
  return truncateForDetail(String(err));
}

/**
 * Trả về true nếu ghi được, false nếu không. Không throw trong mọi trường
 * hợp: DB lỗi, thiếu env service key (createAdminClient throw), bảng chưa
 * migrate — tất cả đều rơi vào catch.
 */
export async function recordSystemJob(
  entry: SystemJobEntry,
  options: RecordJobOptions = {},
): Promise<boolean> {
  try {
    const admin = options.client ?? createAdminClient();
    const { error } = await admin.from("system_jobs").insert({
      job_name: entry.jobName,
      ok: entry.ok,
      duration_ms: entry.durationMs ?? null,
      detail: entry.detail ?? null,
    });
    if (error) {
      console.error("[system-jobs] insert failed", {
        job: entry.jobName,
        message: error.message,
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[system-jobs] insert threw", {
      job: entry.jobName,
      message: errorMessage(err),
    });
    return false;
  }
}
