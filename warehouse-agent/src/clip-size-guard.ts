/**
 * Guard dung lượng clip TRƯỚC khi PUT lên bucket.
 *
 * Vì sao cần: trần file của Supabase project đo được 2026-08-07 bằng
 * cách PUT file tăng dần qua đúng đường signed-upload-url —
 *   50 MiB → 200 OK
 *   51 MiB → 413 EntityTooLarge
 * Trần đúng bằng 50 MiB (52.428.800 byte), và nó nằm ở tầng project chứ
 * không phải bucket (bucket `proof-clips-transient` set 500MB).
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
 * Ngưỡng mặc định = ĐÚNG trần đo được, không trừ biên. Bản đầu để
 * 49 MiB và E2E production chứng minh sai — xem chú thích ở config.ts.
 * Guard chỉ đổi 413 khó hiểu thành thông báo rõ; nó không phải chỗ tạo
 * headroom.
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
 * So sánh dùng `>` (không phải `>=`): file đúng bằng trần vẫn upload được
 * — đã verify 50 MiB chẵn trả 200.
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
