/**
 * Ước lượng dung lượng proof clip TRƯỚC khi cắt, để cảnh báo sớm.
 *
 * Vì sao cần: agent chỉ biết clip vượt trần upload SAU khi render xong,
 * và người vận hành chỉ biết khi khách bấm xem video rồi thấy lỗi. Đơn
 * đóng bằng ra ca có thể dài 500s+ → clip ~130 MB, vẫn vượt trần upload
 * kể cả sau khi project nâng lên 100 MiB (2026-08-13).
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
 * định. Đây là lý do UI KHÔNG được tự viết con số: nó chỉ hiển thị
 * `upload_guard_bytes` mà API trả về.
 *
 * Mặc định 90 MiB (2026-08-13), dưới trần project 100 MiB. Trước đó là
 * 50 MiB = đúng trần gói Free.
 *
 * Đây là hai máy khác nhau đọc cùng một tên env: đổi bên này mà quên
 * bên kia thì bảng cảnh báo nói một đằng, agent chặn một nẻo — mà không
 * ai thấy vì cả hai đều "có số".
 *
 * Về lâu dài agent nên khai báo trần thật của nó qua heartbeat để cloud
 * không phải đoán; chưa mở scope đó ở đây.
 */
export function getProofUploadGuardBytes(): number {
  const raw = Number(process.env.MAX_PROOF_CLIP_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90 * MIB;
}

/**
 * Hệ số bù chênh giữa "tổng byte nguồn" và "byte file thật".
 *
 * ffmpeg cắt copy theo keyframe nên clip dôi vài giây so với cửa sổ yêu
 * cầu, cộng overhead container. Đo trên 9 clip có phủ 100% của camera
 * Dahua 01 (2026-08-07), lệch thực tế/ước lượng:
 *
 *   0,9 · 3,1 · 3,8 · 3,8 · 4,1 · 4,9 · 5,4 · 6,5 · 23,5 %
 *
 * Mẫu 23,5% là clip 20s — dôi 5s keyframe trên nền quá ngắn nên tỷ lệ
 * lớn, và nhóm clip ngắn không bao giờ nằm gần trần 50 MiB nên không
 * kéo hệ số lên. Nhóm cần phân loại chính xác là clip 180–500s, đang
 * lệch 1–6,5% với tâm ~4%. Chọn 1.05.
 *
 * Áp cho CẢ HAI phương pháp ước lượng: cả hai đều đang dự báo output
 * của cùng một phép ffmpeg copy có dôi keyframe.
 *
 * Đây là hệ số ĐO ĐƯỢC, không phải biên an toàn bịa ra. Benchmark lại
 * thì cập nhật con số, đừng cộng thêm biên cho "chắc ăn".
 */
export function getProofSizeEstimateFactor(): number {
  const raw = Number(process.env.PROOF_SIZE_ESTIMATE_FACTOR);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.05;
}

/**
 * Ngưỡng CẢNH BÁO (amber), thấp hơn trần upload. Không chặn gì — chỉ
 * để người vận hành thấy đơn đang tiến sát giới hạn.
 *
 * Mặc định 80 MiB, dưới guard 90 MiB.
 *
 * Lịch sử để không đọc nhầm ý: hồi trần project là 50 MiB, ngưỡng này
 * để 49 MiB và gần như MỌI đơn capped 190s ở Đại Kim đều hiện
 * `near_limit` (clip thật ~49,4 MiB, đo 2026-08-07). Khi đó amber là
 * SỰ THẬT — kho chạy ở ~99% trần upload — và ghi chú cũ cấm nâng ngưỡng
 * để "cho bảng đỡ vàng".
 *
 * Lần này bảng hết vàng vì lý do KHÁC: trần thật đã nới 50 → 100 MiB,
 * clip 3 phút 45–50 MiB không còn ở gần giới hạn nào cả. Ngưỡng đi theo
 * trần mới chứ không phải nới ra để giấu tín hiệu. Nếu sau này amber
 * quay lại ở ngưỡng 80 MiB thì nó lại là sự thật, và cách sửa vẫn là hạ
 * bitrate camera — không phải nâng tiếp con số này.
 */
export function getProofSizeWarnBytes(): number {
  const raw = Number(process.env.PROOF_CLIP_WARN_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 80 * MIB;
}

export interface ProofSizeThresholds {
  guardBytes: number;
  warnBytes: number;
  /** true khi ngưỡng cảnh báo đã bị kéo xuống vì cấu hình sai thứ tự. */
  warnNormalized: boolean;
}

/**
 * Lấy CẢ HAI ngưỡng cùng lúc, đã đảm bảo `warn < guard`.
 *
 * Vì sao trả cặp thay vì hai getter rời: hai ngưỡng chỉ có nghĩa khi
 * đứng cạnh nhau. Ops hạ `MAX_PROOF_CLIP_UPLOAD_BYTES` xuống 45 MiB mà
 * quên `PROOF_CLIP_WARN_BYTES` vẫn 48 MiB thì `near_limit` nằm TRÊN
 * `over_limit` — phân loại vô nghĩa mà không ai thấy. Gọi rời hai getter
 * là còn để ngỏ khả năng đó.
 *
 * Chọn NORMALIZE (kẹp xuống) thay vì fail-fast: đây là tính năng cảnh
 * báo, không chặn gì cả. Ném lỗi vì một ngưỡng sai sẽ làm mất luôn tín
 * hiệu — đổi một sai lệch nhỏ về phân loại lấy việc mù hoàn toàn. Cấu
 * hình sai vẫn được log to kèm cả hai số để không im lặng trôi qua, và
 * `warn_bytes` API trả về là giá trị ĐÃ kẹp, nên xem response là biết
 * ngưỡng thật đang chạy.
 */
export function resolveProofSizeThresholds(): ProofSizeThresholds {
  const guardBytes = getProofUploadGuardBytes();
  const configuredWarn = getProofSizeWarnBytes();

  if (configuredWarn < guardBytes) {
    return { guardBytes, warnBytes: configuredWarn, warnNormalized: false };
  }

  // Kẹp xuống dưới guard. Với guard quá nhỏ (cấu hình sai nặng), lùi
  // theo tỷ lệ để warn không rơi xuống 0 — warn = 0 biến MỌI clip thành
  // near_limit, tệ hơn cả cấu hình sai ban đầu.
  const clamped = guardBytes - MIB;
  const warnBytes = clamped > 0 ? clamped : Math.floor(guardBytes * 0.9);

  console.warn(
    `[proof-size] PROOF_CLIP_WARN_BYTES=${configuredWarn} >= ` +
      `MAX_PROOF_CLIP_UPLOAD_BYTES=${guardBytes} — ngưỡng cảnh báo phải THẤP HƠN ` +
      `trần upload. Đang kẹp xuống ${warnBytes}. Sửa env để hết dòng log này.`,
  );

  return { guardBytes, warnBytes, warnNormalized: true };
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
  /**
   * Hệ số đã nhân vào ước lượng. Trả ra để lần benchmark sau không phải
   * đoán production đang chạy công thức nào.
   */
  estimate_correction_factor: number;
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
  /**
   * Hệ số bù keyframe + container. Bỏ trống thì lấy
   * getProofSizeEstimateFactor(). Test truyền vào để cố định.
   */
  correctionFactor?: number;
}

export function estimateProofSize(input: EstimateInput): ProofSizeEstimate {
  const { window, segments, fallbackBytesPerSecond, guardBytes, warnBytes } =
    input;
  const factor = input.correctionFactor ?? getProofSizeEstimateFactor();
  const windowSeconds = window.windowSeconds;

  const base = {
    proof_window_seconds: windowSeconds,
    upload_guard_bytes: guardBytes,
    estimate_correction_factor: factor,
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
    // Hệ số áp ở CẢ HAI nhánh: dù ước lượng từ segment thật hay từ p95,
    // thứ cần dự báo vẫn là byte file ffmpeg copy xuất ra.
    const bytes = Math.round(sumBytes * factor);
    return {
      ...base,
      proof_size_risk: classify(bytes, guardBytes, warnBytes),
      estimated_file_size_bytes: bytes,
      estimated_bitrate_kbps: bitrateKbps(bytes, windowSeconds),
      estimate_method: "overlapping_segments",
    };
  }

  if (fallbackBytesPerSecond && fallbackBytesPerSecond > 0) {
    const bytes = Math.round(fallbackBytesPerSecond * windowSeconds * factor);
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
