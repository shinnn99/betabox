/**
 * Guard dung lượng clip TRƯỚC khi PUT lên bucket.
 *
 * Vì sao cần: Storage trả 413 EntityTooLarge khi file vượt trần, và
 * trần đó nằm ở tầng PROJECT chứ không phải bucket. Bucket
 * `proof-clips-transient` đang set 500 MB — migration tạo bucket ghi
 * 100 MiB nhưng giá trị sống trong DB đã được đổi sau đó, nên đọc
 * dashboard chứ đừng đọc migration. Bucket chưa bao giờ là chỗ chặn:
 * phép đo 2026-08-07 (gói Free) cho 50 MiB → 200 OK, 51 MiB → 413
 * trong khi bucket đã là 500 MB — chính nó chứng minh tầng project mới
 * là tầng cắn. Từ 2026-08-13 project lên gói trả phí, global upload
 * limit nâng 50 → 100 MiB — đo lại cùng phương pháp: 100 MiB → 200 OK,
 * 101 MiB → 413.
 *
 * Trước guard này agent cứ PUT rồi mới biết, và khách chỉ nhận được
 * chuỗi HTTP thô ("upload_put_failed[http_4xx]: http_400 ...") không nói
 * được clip nặng bao nhiêu, dài bao nhiêu, bitrate bao nhiêu — không
 * chẩn đoán từ xa được.
 *
 * Quyết định theo BYTE THẬT từ stat(), không suy từ duration: bitrate
 * camera thay đổi (đổi cam, đổi độ phân giải, cảnh động) thì mọi công
 * thức theo duration sai ngay.
 *
 * Ngưỡng mặc định 90 MiB, dưới trần project 100 MiB — xem chú thích
 * `MAX_PROOF_CLIP_UPLOAD_BYTES` ở config.ts để biết vì sao lần này đặt
 * dưới trần là đúng còn hồi 49/50 MiB thì sai. Guard chỉ đổi 413 khó
 * hiểu thành thông báo rõ; nó không phải chỗ tạo headroom.
 */

export interface ClipSizeInput {
  /** Byte thật của file đã render, lấy từ stat(). */
  fileSizeBytes: number;
  /** Độ dài clip (giây), dùng để tính bitrate cho thông điệp lỗi. */
  durationSeconds: number;
  /** Trần cho phép PUT, mặc định lấy từ config.maxProofClipUploadBytes. */
  limitBytes: number;
}

export interface ClipSizeRejection {
  /** Câu người đọc, hiện thẳng cho user ở /watch. */
  message: string;
  /** Số liệu máy đọc, ghi vào generation_params để chẩn đoán từ xa. */
  metadata: {
    file_size_bytes: number;
    duration_seconds: number;
    bitrate_kbps: number;
    limit_bytes: number;
  };
}

const MIB = 1024 * 1024;

/** Bitrate trung bình của clip theo kbps. 0 khi duration không hợp lệ. */
export function computeClipBitrateKbps(
  fileSizeBytes: number,
  durationSeconds: number,
): number {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return 0;
  return Math.round((fileSizeBytes * 8) / durationSeconds / 1000);
}

/**
 * @returns `null` khi clip được phép upload; object mô tả lý do khi vượt trần.
 *
 * So sánh dùng `>` (không phải `>=`): file đúng bằng ngưỡng vẫn upload
 * được. Hồi guard = đúng trần project, điều này đã verify bằng phép đo
 * (50 MiB chẵn trả 200). Nay guard nằm dưới trần project nên file đúng
 * bằng guard chắc chắn qua được — giữ `>` để không chặn oan.
 */
export function evaluateClipSize(input: ClipSizeInput): ClipSizeRejection | null {
  const { fileSizeBytes, durationSeconds, limitBytes } = input;
  if (!(fileSizeBytes > limitBytes)) return null;

  const kbps = computeClipBitrateKbps(fileSizeBytes, durationSeconds);
  const mb = (fileSizeBytes / MIB).toFixed(1);
  const limitMb = (limitBytes / MIB).toFixed(1);
  const durText = Number.isFinite(durationSeconds)
    ? durationSeconds.toFixed(0)
    : "?";

  return {
    message:
      `proof_clip_too_large: ${mb}MB vượt trần upload ${limitMb}MB ` +
      `(clip ${durText}s, bitrate ${kbps}kbps). ` +
      `Giảm bitrate camera hoặc rút ngắn cửa sổ clip.`,
    metadata: {
      file_size_bytes: fileSizeBytes,
      duration_seconds: Number.isFinite(durationSeconds)
        ? Math.round(durationSeconds)
        : 0,
      bitrate_kbps: kbps,
      limit_bytes: limitBytes,
    },
  };
}
