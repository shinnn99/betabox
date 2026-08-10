import "server-only";
import type { ActivityPayload } from "@/lib/warehouse/live/activity";

export interface ActivitySection {
  activity: ActivityPayload | null;
  activity_error: string | null;
}

/**
 * Hạ lỗi của riêng phần nhật ký xuống một field, KHÔNG cho nó đánh hỏng
 * cả phản hồi overview.
 *
 * Đây là bất biến quan trọng nhất của việc gộp bốn endpoint thành một.
 * Hồi còn bốn endpoint rời, nhật ký hỏng chỉ làm hiện một dòng lỗi nhỏ
 * dưới bảng, còn KPI và thẻ bàn đóng hàng vẫn vẽ. Gộp mà không giữ ranh
 * giới này thì một lỗi nhật ký sẽ thổi bay cả màn hình giám sát — đúng
 * lúc người ở kho cần nhìn nhất.
 *
 * Ba ca:
 *   - không xin nhật ký (ngày quá khứ, nhịp poll) → cả hai field null.
 *   - xin và lấy được          → activity có, activity_error null.
 *   - xin nhưng hỏng           → activity null, activity_error có nội dung.
 */
export async function resolveActivitySection(
  includeActivity: boolean,
  run: () => Promise<ActivityPayload>,
): Promise<ActivitySection> {
  if (!includeActivity) return { activity: null, activity_error: null };
  try {
    return { activity: await run(), activity_error: null };
  } catch (e) {
    return {
      activity: null,
      activity_error: (e as Error)?.message || "activity_failed",
    };
  }
}
