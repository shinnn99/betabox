/**
 * Quyết định "row segment đang mở này có thật sự là segment ĐANG GHI
 * không" — tách riêng khỏi clip-resolver để test được (resolver import
 * `server-only` + admin client).
 *
 * Vì sao cần tách khái niệm này:
 *
 * `camera_recording_files.ended_at = NULL` mang HAI nghĩa khác hẳn nhau,
 * mà resolver trước đây gộp làm một:
 *
 *   (A) Segment ffmpeg ĐANG ghi ngay lúc này. Đuôi video chưa flush
 *       xuống ổ → cắt bây giờ ra clip hỏng. Phải chặn, bảo user thử lại.
 *   (B) Row MỒ CÔI: agent chết/mất điện giữa segment nên không kịp ghi
 *       `ended_at`. File trên ổ đã đóng từ lâu (hoặc đã bị cleanup xóa),
 *       không ai đóng row đó nữa. Chặn ở đây là chặn vĩnh viễn.
 *
 * Bug đã cắn thật (2026-09-04, kho Đại Kim): 1 row mồ côi từ 27/08
 * (`dahua_01/2026/08/27/dahua_01_20260827_142531.mp4`, ghi hình dừng
 * hẳn tại segment đó). Điều kiện chặn cũ chỉ hỏi `started_at <= clipEnd`
 * — mà một row từ 27/08 có `started_at` nhỏ hơn MỌI `clipEnd` sau đó,
 * nên nó đầu độc TOÀN BỘ đơn của camera này từ 27/08 tới 04/09: 92 đơn,
 * không đơn nào cắt được clip. Bấm "Thử lại" vô ích vì row mồ côi không
 * bao giờ tự đóng.
 *
 * Luật mới: một row open chỉ được coi là "đang ghi" khi nó còn TRẺ so
 * với thời điểm chốt cửa sổ clip. Segment dài ~60s; row open mà
 * `started_at` đã cách `clipEnd` quá ngưỡng dưới đây thì chắc chắn
 * không phải file ffmpeg đang cầm — file đó đã phải rolled sang tên
 * khác từ lâu.
 */

/**
 * Ngưỡng tuổi tối đa của một row open để còn được coi là "đang ghi".
 *
 * Chọn 10 phút = 10× độ dài segment (60s). Rộng rãi có chủ đích:
 *   - Đủ chỗ cho lệch đồng hồ máy kho ↔ cloud (`time_drift_seconds`),
 *     cho segment dài bất thường khi ổ SMB lag, và cho ca ffmpeg treo
 *     mà watchdog chưa kịp giết.
 *   - Vẫn chặt hơn nhiều so với "vô hạn" của luật cũ: một row mồ côi
 *     8 ngày tuổi không còn khả năng chặn đơn nào.
 *
 * Đây là ngưỡng AN TOÀN LỆCH VỀ PHÍA CHẶN: trong vùng nghi ngờ (row
 * open còn trẻ) ta vẫn chặn và bảo user thử lại, vì cắt nhầm segment
 * chưa flush cho ra clip hỏng — tệ hơn là bắt user đợi thêm một nhịp.
 */
export const OPEN_SEGMENT_MAX_AGE_SECONDS = 600;

export interface OpenSegmentInput {
  /** `camera_recording_files.started_at` (ISO). */
  started_at: string;
  /** `camera_recording_files.ended_at` — null nghĩa là row còn mở. */
  ended_at: string | null;
}

export interface OpenSegmentVerdict {
  /**
   * true = có segment ĐANG GHI phủ cửa sổ → chặn cắt, bảo user thử lại.
   */
  blocking: boolean;
  /**
   * Row open bị xếp loại mồ côi (quá cũ để còn đang ghi). Resolver log
   * chúng ra để ops thấy — im lặng bỏ qua thì bug này lần sau lại mất
   * 8 ngày mới phát hiện.
   */
  staleOpen: OpenSegmentInput[];
}

/**
 * @param files  Các row segment giao với cửa sổ clip (đã lọc theo camera
 *               + org + source ở tầng gọi).
 * @param clipEnd Biên cuối cửa sổ clip.
 * @param maxAgeSeconds Ngưỡng tuổi, mặc định `OPEN_SEGMENT_MAX_AGE_SECONDS`.
 */
export function evaluateOpenSegments(
  files: OpenSegmentInput[],
  clipEnd: Date,
  maxAgeSeconds: number = OPEN_SEGMENT_MAX_AGE_SECONDS,
): OpenSegmentVerdict {
  const clipEndMs = clipEnd.getTime();
  const maxAgeMs = maxAgeSeconds * 1000;
  const staleOpen: OpenSegmentInput[] = [];
  let blocking = false;

  for (const f of files) {
    if (f.ended_at !== null) continue;

    const startedMs = new Date(f.started_at).getTime();
    // started_at không parse được → không dám kết luận "mồ côi" (có thể
    // là row đang ghi thật với timestamp lạ). Chặn cho an toàn.
    if (!Number.isFinite(startedMs)) {
      blocking = true;
      continue;
    }

    // Row bắt đầu SAU biên cuối cửa sổ: không liên quan tới clip này.
    // Luật cũ đã bỏ qua ca này, giữ nguyên.
    if (startedMs > clipEndMs) continue;

    // Còn trẻ so với clipEnd → nhiều khả năng đây chính là file ffmpeg
    // đang cầm lúc đơn kết thúc. Chặn.
    if (clipEndMs - startedMs <= maxAgeMs) {
      blocking = true;
      continue;
    }

    // Quá cũ để còn đang ghi → mồ côi. Không chặn; tầng gọi sẽ loại nó
    // khỏi danh sách file dùng để cắt (nó không có ended_at nên không
    // ghép được vào clip).
    staleOpen.push(f);
  }

  return { blocking, staleOpen };
}
