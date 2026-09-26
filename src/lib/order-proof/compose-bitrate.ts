/**
 * Bitrate mà AGENT dùng khi nén lại clip bằng chứng — bản sao phía cloud của
 * `warehouse-agent/src/compose/bitrate.ts` (có bài test canh hai bên khớp).
 *
 * Vì sao cloud cần: bộ ước lượng dung lượng (proof-size-*.ts) trước đây tính
 * MỌI clip theo dung lượng THÔ của camera toàn cảnh, như thể clip được chép
 * thẳng (`-c copy`). Nhưng clip của bàn HAI GÓC được ghép rồi NÉN LẠI ở
 * 3200 kbps: clip 180 giây chỉ ~69 MiB. Đại Kim (camera toàn cảnh ~5,8 Mbps)
 * vì thế hiện "Proof có nguy cơ vượt giới hạn ~130 MiB" ở gần như mọi đơn —
 * báo nhầm (chủ dự án chỉ ra 26/09/2026).
 *
 * Hàm thuần.
 */

export const BASE_VIDEO_KBPS = 3200;
export const MIN_VIDEO_KBPS = 800;
export const SIZE_HEADROOM = 0.85;

/**
 * Vỏ MP4 + dao động bitrate quanh mức đặt của libx264 (ABR có trần đỉnh).
 * Ước lượng thận trọng — thà báo cao hơn thật một chút.
 */
export const REENCODE_CONTAINER_FACTOR = 1.03;

/** kbps agent sẽ dùng cho một clip dài `durationSeconds` với ngưỡng tải lên `maxOutputBytes`. */
export function reencodeKbpsFor(durationSeconds: number, maxOutputBytes: number): number {
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds) || !(maxOutputBytes > 0)) return BASE_VIDEO_KBPS;
  const budget = Math.floor((maxOutputBytes * 8 * SIZE_HEADROOM) / durationSeconds / 1000);
  if (budget >= BASE_VIDEO_KBPS) return BASE_VIDEO_KBPS;
  return Math.max(MIN_VIDEO_KBPS, budget);
}

/** Dung lượng ước tính (byte) của clip nén lại dài `durationSeconds`. */
export function reencodedBytes(durationSeconds: number, maxOutputBytes: number): number {
  const kbps = reencodeKbpsFor(durationSeconds, maxOutputBytes);
  return Math.round(((kbps * 1000) / 8) * durationSeconds * REENCODE_CONTAINER_FACTOR);
}
