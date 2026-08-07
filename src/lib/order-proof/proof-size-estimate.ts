/**
 * Ước lượng dung lượng proof clip TRƯỚC khi cắt, để cảnh báo sớm.
 *
 * Vì sao cần: agent chỉ biết clip vượt trần upload SAU khi render xong,
 * và người vận hành chỉ biết khi khách bấm xem video rồi thấy lỗi. Đơn
 * đóng bằng ra ca có thể dài 500s+ → clip ~130 MB, chắc chắn vượt trần
 * 50 MiB của project.
 *
 * Đây CHỈ là visibility. Không cắt ngắn, không transcode, không đổi
 * `work_duration_seconds`. Nó không chặn gì cả, nên ngưỡng cảnh báo
 * được đặt thấp hơn trần upload mà không sợ "chặn oan".
 *
 * Thứ tự ước lượng (chính xác trước, phỏng đoán sau):
 *
 *   1. Cửa sổ clip lấy từ computeFinalizedClipWindow — CÙNG hàm bộ sinh
 *      clip dùng. Không nhân `work_duration_seconds` với bitrate: cửa sổ
 *      thật còn có pre-roll, buffer, sàn và trần.
 *   2. Có segment ghi hình phủ cửa sổ đó → cộng byte theo phần chồng lấn
 *      của chính các segment ấy. Đây là dữ liệu thật của chính đơn này.
 *   3. Thiếu segment / thiếu metadata → mới rơi xuống bitrate p95 gần đây
 *      của đúng camera đó.
 *
 * KHÔNG cộng thêm hệ số an toàn nào. Pipeline cắt hiện tại là remux
 * copy codec nên tổng byte segment sát với byte clip. Nếu sau này đo
 * production thấy overhead ổn định thì thêm hệ số DỰA TRÊN SỐ ĐO, đừng
 * bịa 10–20% từ đầu.
 */

import type { ClipWindow } from "@/lib/order-proof/clip-window";

const MIB = 1024 * 1024;

/**
 * Trần upload — phải cùng ngữ nghĩa với `MAX_PROOF_CLIP_UPLOAD_BYTES`
 * của agent (warehouse-agent/src/config.ts). Cùng tên env, cùng mặc
 * định. Đây là lý do UI KHÔNG được tự viết 49 MiB: nó chỉ hiển thị
 * `upload_guard_bytes` mà API trả về.
 *
 * Về lâu dài agent nên khai báo trần thật của nó qua heartbeat để cloud
 * không phải đoán; chưa mở scope đó ở đây.
 */
export function getProofUploadGuardBytes(): number {
  const raw = Number(process.env.MAX_PROOF_CLIP_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 49 * MIB;
}

/**
 * Ngưỡng CẢNH BÁO (amber), thấp hơn trần upload. Không chặn gì — chỉ
 * để người vận hành thấy đơn đang tiến sát giới hạn.
 *
 * Mặc định 48 MiB chứ không phải 47 MiB. Lý do là số đo, không phải cảm
 * tính: clip capped_timeout 190s của kho Đại Kim rơi vào 45–49 MB, nên
 * tỷ lệ bị bôi vàng trên 4491 segment thật (14 ngày) là
 *
 *   ngưỡng 47 MiB → 89,0% clip capped thành amber
 *   ngưỡng 48 MiB →  7,9%
 *   guard  49 MiB →  0,2% thật sự vượt
 *
 * 89% amber tức là cảnh báo mất hết ý nghĩa ngay ngày đầu. 48 MiB giữ
 * được tín hiệu mà vẫn báo trước khi chạm guard.
 *
 * Hạ về 47 MiB bằng env nếu muốn nhạy hơn — nó không chặn gì cả, chỉ
 * đổi lượng nhiễu. Đừng biến amber thành đỏ.
 */
export function getProofSizeWarnBytes(): number {
  const raw = Number(process.env.PROOF_CLIP_WARN_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 48 * MIB;
}

export const PROOF_SIZE_RISKS = [
  "safe",
  "near_limit",
  "over_limit",
  "unknown",
] as const;
export type ProofSizeRisk = (typeof PROOF_SIZE_RISKS)[number];

export type ProofSizeEstimateMethod =
  /** Cộng byte từ chính các segment phủ cửa sổ clip. */
  | "overlapping_segments"
  /** Không đủ segment phủ cửa sổ → dùng bitrate p95 gần đây của camera. */
  | "camera_recent_p95"
  /** Không có dữ liệu nào để ước lượng. */
  | "none";

export interface SegmentForEstimate {
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
}

export interface ProofSizeEstimate {
  proof_size_risk: ProofSizeRisk;
  estimated_file_size_bytes: number | null;
  estimated_bitrate_kbps: number | null;
  proof_window_seconds: number;
  upload_guard_bytes: number;
  estimate_method: ProofSizeEstimateMethod;
}

/**
 * Tỷ lệ cửa sổ phải được segment phủ thì mới tin tổng byte. Dưới mức
 * này (camera tắt giữa chừng, segment chưa report kịp) thì tổng sẽ thấp
 * giả tạo → chuyển sang p95 thay vì báo "safe" sai.
 */
const MIN_SEGMENT_COVERAGE_RATIO = 0.9;

/** Byte chồng lấn giữa cửa sổ clip và một segment. */
function overlapBytes(
  window: { clipStart: Date; clipEnd: Date },
  seg: SegmentForEstimate,
): { bytes: number; seconds: number } | null {
  const size = seg.file_size_bytes;
  if (typeof size !== "number" || size <= 0) return null;

  const segStartMs = new Date(seg.started_at).getTime();
  if (!Number.isFinite(segStartMs)) return null;

  // ended_at là nguồn chuẩn; thiếu thì suy từ duration.
  let segEndMs: number;
  if (seg.ended_at) {
    segEndMs = new Date(seg.ended_at).getTime();
  } else if (typeof seg.duration_seconds === "number" && seg.duration_seconds > 0) {
    segEndMs = segStartMs + seg.duration_seconds * 1000;
  } else {
    return null;
  }
  if (!Number.isFinite(segEndMs) || segEndMs <= segStartMs) return null;

  const segDurationMs = segEndMs - segStartMs;
  const overlapMs =
    Math.min(segEndMs, window.clipEnd.getTime()) -
    Math.max(segStartMs, window.clipStart.getTime());
  if (overlapMs <= 0) return null;

  const ratio = Math.min(1, overlapMs / segDurationMs);
  return { bytes: size * ratio, seconds: overlapMs / 1000 };
}

export interface EstimateInput {
  window: ClipWindow;
  /** Segment của đúng camera bằng chứng, đã lọc theo khoảng cửa sổ. */
  segments: SegmentForEstimate[];
  /**
   * Bitrate dự phòng (byte/giây) của chính camera đó, tính từ lịch sử
   * gần đây. null nếu camera chưa có dữ liệu.
   */
  fallbackBytesPerSecond: number | null;
  guardBytes: number;
  warnBytes: number;
}

export function estimateProofSize(input: EstimateInput): ProofSizeEstimate {
  const { window, segments, fallbackBytesPerSecond, guardBytes, warnBytes } =
    input;
  const windowSeconds = window.windowSeconds;

  const base = {
    proof_window_seconds: windowSeconds,
    upload_guard_bytes: guardBytes,
  };

  if (windowSeconds <= 0) {
    return {
      ...base,
      proof_size_risk: "unknown",
      estimated_file_size_bytes: null,
      estimated_bitrate_kbps: null,
      estimate_method: "none",
    };
  }

  let sumBytes = 0;
  let coveredSeconds = 0;
  for (const seg of segments) {
    const o = overlapBytes(window, seg);
    if (!o) continue;
    sumBytes += o.bytes;
    coveredSeconds += o.seconds;
  }

  const coverage = coveredSeconds / windowSeconds;
  if (sumBytes > 0 && coverage >= MIN_SEGMENT_COVERAGE_RATIO) {
    const bytes = Math.round(sumBytes);
    return {
      ...base,
      proof_size_risk: classify(bytes, guardBytes, warnBytes),
      estimated_file_size_bytes: bytes,
      estimated_bitrate_kbps: bitrateKbps(bytes, windowSeconds),
      estimate_method: "overlapping_segments",
    };
  }

  if (fallbackBytesPerSecond && fallbackBytesPerSecond > 0) {
    const bytes = Math.round(fallbackBytesPerSecond * windowSeconds);
    return {
      ...base,
      proof_size_risk: classify(bytes, guardBytes, warnBytes),
      estimated_file_size_bytes: bytes,
      estimated_bitrate_kbps: bitrateKbps(bytes, windowSeconds),
      estimate_method: "camera_recent_p95",
    };
  }

  return {
    ...base,
    proof_size_risk: "unknown",
    estimated_file_size_bytes: null,
    estimated_bitrate_kbps: null,
    estimate_method: "none",
  };
}

export function classify(
  bytes: number,
  guardBytes: number,
  warnBytes: number,
): ProofSizeRisk {
  if (bytes > guardBytes) return "over_limit";
  if (bytes >= warnBytes) return "near_limit";
  return "safe";
}

function bitrateKbps(bytes: number, seconds: number): number {
  if (!(seconds > 0)) return 0;
  return Math.round((bytes * 8) / seconds / 1000);
}

/**
 * p95 byte/giây từ danh sách file ghi hình của một camera. p95 chứ
 * không phải trung bình: cảnh báo nên nghiêng về phía "có thể nặng hơn
 * bình thường", vì bỏ sót cảnh báo tệ hơn cảnh báo hơi sớm.
 */
export function percentile95BytesPerSecond(
  files: Array<{ duration_seconds: number | null; file_size_bytes: number | null }>,
): number | null {
  const rates: number[] = [];
  for (const f of files) {
    const d = f.duration_seconds;
    const s = f.file_size_bytes;
    if (typeof d !== "number" || d <= 0) continue;
    if (typeof s !== "number" || s <= 0) continue;
    rates.push(s / d);
  }
  if (rates.length === 0) return null;
  rates.sort((a, b) => a - b);
  const idx = Math.min(rates.length - 1, Math.floor(rates.length * 0.95));
  return rates[idx];
}
