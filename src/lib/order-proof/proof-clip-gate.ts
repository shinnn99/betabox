/**
 * Cổng quyết định "đơn này có được cắt proof clip chưa".
 *
 * Vì sao tách riêng: có HAI đường vào `enqueueCutClip` — `/watch` (tự
 * động khi user mở video) và `/watch/retry` (bấm tay). Trước đây mỗi
 * đường tự kiểm điều kiện, và cả hai đều KHÔNG kiểm timing_status → mở
 * /watch lúc đơn chưa đóng vẫn cắt.
 *
 * Hậu quả đã cắn thật (kho Đại Kim): clip SPXVN066995638828 dài 70s với
 * end_reason='default_post', trong khi packing_event đó có
 * work_duration_seconds=180. Clip cụt ĐÓ được lưu làm bằng chứng chính
 * thức. Đây là lỗi toàn vẹn bằng chứng, không phải lỗi hiển thị.
 *
 * Gốc kỹ thuật: đơn `open` chưa có `work_ended_at`, nên clip-resolver rơi
 * xuống nhánh fallback và lấy `video_default_post_seconds` (60s mặc
 * định) làm biên cuối — một con số phỏng đoán, không phải biên thật của
 * đơn.
 *
 * Quy tắc: đơn còn `open` thì KHÔNG sinh proof clip. Đợi đơn đóng (scan
 * kế / ra ca / cron đóng ca treo) rồi resolver mới có biên thật.
 */

/** Giá trị `packing_events.timing_status` nghĩa là đơn chưa đóng. */
export const TIMING_STATUS_OPEN = "open";

export interface ProofClipGateResult {
  /** true = được phép enqueue cut. */
  allowed: boolean;
  /** Mã lỗi máy đọc, chỉ có khi bị chặn. */
  reason?: "order_still_open";
  /** Câu người đọc, chỉ có khi bị chặn. */
  message?: string;
}

const ALLOWED: ProofClipGateResult = { allowed: true };

/**
 * @param timingStatus `packing_events.timing_status` của đơn.
 *
 * null/undefined được coi là CHO PHÉP: row cũ trước khi có cột timing,
 * và `not_applicable` (đơn trùng/chưa vào ca) — chặn chúng sẽ làm mất
 * khả năng xem clip của dữ liệu hợp lệ. Chỉ đúng giá trị 'open' mới
 * chặn, vì chỉ nó chắc chắn thiếu biên cuối.
 */
export function evaluateProofClipGate(
  timingStatus: string | null | undefined,
): ProofClipGateResult {
  if (timingStatus === TIMING_STATUS_OPEN) {
    return {
      allowed: false,
      reason: "order_still_open",
      message:
        "Đơn đang được đóng gói. Clip đầy đủ sẽ có sau khi đơn kết thúc.",
    };
  }
  return ALLOWED;
}
