/**
 * Bitrate cho clip bằng chứng nén lại — vừa ngưỡng tải lên dù clip dài
 * (bản 0.13.0, kế hoạch VAN-HANH-NHIEU-KHO đợt 7, phần 3.6).
 *
 * Trước 0.13.0 bộ ghép luôn nén 3200 kbps. Clip kiện hoàn 310s ở bitrate đó
 * ≈ 117 MiB, vượt ngưỡng 90 MiB → agent từ chối tải lên, mất trắng. Nên
 * cloud phải cắt clip kiện hoàn ở 180s — 2 phút cuối mỗi kiện hoàn 5 phút
 * không có video bằng chứng.
 *
 * Luật: đủ ngân sách thì GIỮ NGUYÊN 3200k (clip ≤ ~200s — mọi đơn đi: chất
 * lượng không đổi); thiếu thì hạ vừa đủ, chừa 15% cho dao động bitrate và vỏ
 * MP4. Có luật này agent mới khai khả năng `adaptive_clip_bitrate` và cloud
 * mới mở cửa sổ 310s cho kiện hoàn.
 *
 * Hàm thuần.
 */

export const BASE_VIDEO_KBPS = 3200;
export const BASE_MAXRATE_KBPS = 4500;
export const BASE_BUFSIZE_KBPS = 9000;
/** Dưới mức này hình mờ tới mức không còn là bằng chứng — thà để guard từ chối. */
export const MIN_VIDEO_KBPS = 800;
/** Phần ngân sách dùng cho video; 15% còn lại cho dao động bitrate và vỏ MP4. */
export const SIZE_HEADROOM = 0.85;

export interface VideoRate {
  bitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  /** true = đã hạ khỏi mức mặc định để vừa ngưỡng. */
  adapted: boolean;
}

const BASE: VideoRate = {
  bitrateKbps: BASE_VIDEO_KBPS,
  maxrateKbps: BASE_MAXRATE_KBPS,
  bufsizeKbps: BASE_BUFSIZE_KBPS,
  adapted: false,
};

/** Ngân sách kbps trung bình để file dài `durationSeconds` vừa `maxOutputBytes`. */
export function budgetKbps(durationSeconds: number, maxOutputBytes: number): number {
  return Math.floor((maxOutputBytes * 8 * SIZE_HEADROOM) / durationSeconds / 1000);
}

export function videoRateFor(durationSeconds: number, maxOutputBytes?: number): VideoRate {
  if (!maxOutputBytes || !(durationSeconds > 0) || !Number.isFinite(durationSeconds)) return { ...BASE };
  const budget = budgetKbps(durationSeconds, maxOutputBytes);
  if (budget >= BASE_VIDEO_KBPS) return { ...BASE };
  const bitrate = Math.max(MIN_VIDEO_KBPS, budget);
  // Trần đỉnh thấp theo: để nguyên 4500k thì đoạn nhiều chuyển động kéo trung
  // bình vượt ngân sách.
  const maxrate = Math.min(BASE_MAXRATE_KBPS, Math.floor(bitrate * 1.25));
  return { bitrateKbps: bitrate, maxrateKbps: maxrate, bufsizeKbps: maxrate * 2, adapted: true };
}

export function ffmpegRateArgs(rate: VideoRate): string[] {
  return [
    "-b:v", `${rate.bitrateKbps}k`,
    "-maxrate", `${rate.maxrateKbps}k`,
    "-bufsize", `${rate.bufsizeKbps}k`,
  ];
}
