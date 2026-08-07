/**
 * Tính cửa sổ clip cho đơn ĐÃ ĐÓNG — hàm thuần, không đụng DB.
 *
 * Vì sao tách khỏi clip-resolver: có hai nơi cần biết "clip của đơn này
 * dài bao nhiêu" — bộ sinh clip (resolveClipBounds) và bộ ước lượng dung
 * lượng proof (proof-size-estimate). Nếu mỗi nơi tự tính, UI sẽ báo một
 * số còn agent render ra số khác, và cảnh báo "sắp vượt trần" thành vô
 * nghĩa.
 *
 * KHÔNG dùng `work_duration_seconds` làm độ dài clip. Cửa sổ thật gồm
 * pre-roll trước scan, buffer sau khi đóng đơn, sàn tối thiểu và trần
 * tối đa — tất cả nằm ở đây.
 *
 * Chỉ xử lý ca đơn đã đóng (có `work_ended_at`). Đơn còn 'open' không có
 * biên thật nên KHÔNG được sinh proof clip (xem proof-clip-gate.ts) và
 * cũng không ước lượng được.
 */

/**
 * Đệm thêm sau `work_ended_at` để clip không cắt đúng khoảnh khắc quét
 * mã đơn kế — thao tác cuối của đơn trước thường còn dở dang.
 */
export const WORK_ENDED_POST_BUFFER_SECONDS = 5;

/**
 * Sàn độ dài clip. Đơn đóng cực nhanh (VD 3s) vẫn cần đủ hình để nhìn
 * ra hành động đóng gói.
 */
export const MIN_CLIP_DURATION_SECONDS = 15;

/**
 * Trần độ dài clip — giới hạn KỸ THUẬT của proof pipeline, KHÔNG phải
 * ngưỡng nghiệp vụ `max_order_seconds`. Xem ghi chú hai lớp ở
 * clip-resolver.ts.
 */
export const MAX_CLIP_DURATION_SECONDS = 600;

export type FinalizedEndReason =
  | "work_ended"
  | "work_duration_from_capped"
  | "capped_at_max_duration"
  | "work_ended_extended_to_min"
  | "default_post_invalid_work_ended";

export interface FinalizedWindowInput {
  /** `packing_events.scanned_at`. */
  scannedAt: Date;
  /** `packing_events.work_ended_at` — bắt buộc, đơn phải đã đóng. */
  workEndedAt: string;
  /** `packing_events.timing_status`. */
  timingStatus?: string | null;
  /** `packing_events.work_duration_seconds`. */
  workDurationSeconds?: number | null;
  /** `video_pre_seconds` của kho. */
  preSeconds: number;
  /** `video_default_post_seconds` của kho — chỉ dùng ở nhánh phòng thủ. */
  defaultPostSeconds: number;
}

export interface ClipWindow {
  clipStart: Date;
  clipEnd: Date;
  endReason: FinalizedEndReason;
  /** Độ dài file mp4 sẽ ra, tính cả pre-roll. */
  windowSeconds: number;
}

/**
 * Chọn thời điểm kết thúc clip theo `timing_status`:
 *
 *   capped_timeout → KHÔNG dùng work_ended_at (= scan kế thật, cách quá
 *     xa). Dùng `scanned_at + work_duration_seconds` (RPC đã cap ở
 *     max_order_seconds). Duration không hợp lệ → cap ở MAX.
 *   còn lại → dùng work_ended_at + buffer.
 *
 * Sau đó kẹp giữa sàn MIN và trần MAX tính từ `scanned_at`.
 */
export function computeFinalizedClipWindow(
  input: FinalizedWindowInput,
): ClipWindow {
  const { scannedAt, preSeconds, defaultPostSeconds } = input;
  const scannedMs = scannedAt.getTime();
  const clipStart = new Date(scannedMs - preSeconds * 1000);

  const workEndedMs = new Date(input.workEndedAt).getTime();

  // Guard: work_ended_at phải > scanned_at (không rơi vào quá khứ do
  // clock skew / row cũ). Nhánh này gần như không xảy ra (RPC luôn set
  // >= scanned_at), nhưng bảo thủ: fallback thay vì clip 0s.
  if (!Number.isFinite(workEndedMs) || workEndedMs <= scannedMs) {
    const clipEnd = new Date(scannedMs + defaultPostSeconds * 1000);
    return finish(clipStart, clipEnd, "default_post_invalid_work_ended");
  }

  const isCapped = input.timingStatus === "capped_timeout";
  const dur = input.workDurationSeconds;
  const durValid =
    typeof dur === "number" && dur > 0 && dur <= MAX_CLIP_DURATION_SECONDS;

  let candidateMs: number;
  if (isCapped) {
    candidateMs = durValid
      ? scannedMs + dur * 1000 + WORK_ENDED_POST_BUFFER_SECONDS * 1000
      : scannedMs + MAX_CLIP_DURATION_SECONDS * 1000;
  } else {
    candidateMs = workEndedMs + WORK_ENDED_POST_BUFFER_SECONDS * 1000;
  }

  // Trần cứng bất kể nhánh nào — phòng ca work_ended_at vượt max (scan
  // kế đến rất muộn với timing_status='finalized_by_next_scan').
  const maxEndMs = scannedMs + MAX_CLIP_DURATION_SECONDS * 1000;
  if (candidateMs > maxEndMs) {
    return finish(clipStart, new Date(maxEndMs), "capped_at_max_duration");
  }

  const minEndMs = scannedMs + MIN_CLIP_DURATION_SECONDS * 1000;
  if (candidateMs < minEndMs) {
    return finish(clipStart, new Date(minEndMs), "work_ended_extended_to_min");
  }

  return finish(
    clipStart,
    new Date(candidateMs),
    isCapped ? "work_duration_from_capped" : "work_ended",
  );
}

function finish(
  clipStart: Date,
  clipEnd: Date,
  endReason: FinalizedEndReason,
): ClipWindow {
  return {
    clipStart,
    clipEnd,
    endReason,
    windowSeconds: Math.max(
      0,
      Math.round((clipEnd.getTime() - clipStart.getTime()) / 1000),
    ),
  };
}
