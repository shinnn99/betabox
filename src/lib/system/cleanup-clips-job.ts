import "server-only";
import { cleanupExpiredClips, type CleanupError, type CleanupResult } from "@/lib/watch/cleanup";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SYSTEM_JOB_CLEANUP_CLIPS,
  errorMessage,
  recordSystemJob,
  truncateForDetail,
} from "@/lib/system/job-log";

/**
 * Một lần chạy cron dọn clip, có ghi sổ.
 *
 * Tách khỏi route để kiểm được: route phải dựng NextRequest + đọc env, còn
 * đây nhận client qua chữ ký nên test giả lập được cả hai đường DB.
 *
 * Ba điều bảo đảm:
 *   1. Mọi lần chạy ghi đúng 1 dòng `system_jobs` — ok lẫn lỗi lẫn ném
 *      ngoại lệ. Đây là thứ cảnh báo giai đoạn 2 dựa vào.
 *   2. Ghi sổ hỏng KHÔNG làm hỏng việc dọn clip (recordSystemJob không
 *      throw; kết quả dọn trả nguyên vẹn).
 *   3. Ngoại lệ từ việc dọn được ghi sổ rồi ném tiếp — route giữ nguyên
 *      hành vi cũ (Next trả 500), chỉ khác là giờ có dấu vết.
 *
 * KHÔNG truyền organizationId: đường cron là đường toàn hệ có chủ đích
 * (xem nửa-âm trong tests/cleanup-expired-clips-scope.test.ts). Đường bấm
 * tay /api/admin/cleanup-expired-clips CỐ Ý không ghi sổ ở đây — nó dọn
 * trong phạm vi một org, nếu nó ghi cùng job_name thì một cú bấm tay của
 * khách sẽ làm mốc "cron còn sống" tươi lại trong khi cron thật đã chết.
 */
export interface CleanupClipsJobOptions {
  /** Client cho việc dọn clip (chỉ test tiêm vào). */
  clipClient?: ReturnType<typeof createAdminClient>;
  /** Client cho việc ghi sổ (chỉ test tiêm vào). */
  jobClient?: ReturnType<typeof createAdminClient>;
}

export async function runCleanupClipsJob(
  options: CleanupClipsJobOptions = {},
): Promise<CleanupResult | CleanupError> {
  const startedAt = Date.now();

  let result: CleanupResult | CleanupError;
  try {
    result = await cleanupExpiredClips({ client: options.clipClient });
  } catch (err) {
    await recordSystemJob(
      {
        jobName: SYSTEM_JOB_CLEANUP_CLIPS,
        ok: false,
        durationMs: Date.now() - startedAt,
        detail: { error: "exception", message: errorMessage(err) },
      },
      { client: options.jobClient },
    );
    throw err;
  }

  await recordSystemJob(
    {
      jobName: SYSTEM_JOB_CLEANUP_CLIPS,
      ok: result.ok,
      durationMs: Date.now() - startedAt,
      // remove_errors giữ dạng ĐẾM, không giữ nội dung: mỗi phần tử là
      // thông điệp lỗi của storage, có thể kèm đường dẫn file chứa id org
      // và id clip. Chi tiết đầy đủ vẫn ra stderr/journalctl.
      detail: result.ok
        ? {
            deleted: result.deleted,
            cutoff_iso: result.cutoff_iso,
            remove_errors: result.remove_errors?.length ?? 0,
          }
        : {
            error: result.error,
            message: truncateForDetail(result.message),
            remove_errors: result.remove_errors?.length ?? 0,
          },
    },
    { client: options.jobClient },
  );

  return result;
}
