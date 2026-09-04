import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalizedClipWindow,
  MAX_CLIP_DURATION_SECONDS,
} from "../src/lib/order-proof/clip-window.ts";
import {
  classify,
  estimateProofSize,
  getProofSizeEstimateFactor,
  percentile95BytesPerSecond,
  resolveProofSizeThresholds,
  type SegmentForEstimate,
} from "../src/lib/order-proof/proof-size-estimate.ts";

/**
 * Cửa sổ clip + ước lượng dung lượng proof.
 *
 * Số dùng ở đây lấy từ dữ liệu thật kho Đại Kim (2026-08-07): camera
 * Dahua 01 ~256 KB/s trên 4441 segment, segment dài 60s.
 *
 * Trần upload: 2026-08-13 project nâng global upload limit 50 → 100 MiB,
 * guard mặc định về 90 MiB và cảnh báo về 80 MiB. Bitrate camera KHÔNG
 * đổi — đó là lý do các con số byte trong test này giữ nguyên còn phân
 * loại thì đổi.
 */

const MIB = 1024 * 1024;
const GUARD = 90 * MIB;
const WARN = 80 * MIB;
const KBPS_256 = 256 * 1024; // byte/giây
/** Hệ số keyframe + container, đo trên 9 clip thật (xem module). */
const FACTOR = 1.05;

const SCAN = new Date("2026-08-07T08:00:00.000Z");
const iso = (offsetSeconds: number) =>
  new Date(SCAN.getTime() + offsetSeconds * 1000).toISOString();

// ───────── Cửa sổ clip ─────────

test("capped_timeout 180s: cửa sổ = pre + 180 + buffer, KHÔNG dùng work_ended thật", () => {
  // Scan kế đến rất muộn (600s sau) nhưng RPC đã cap duration ở 180.
  const w = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(600),
    timingStatus: "capped_timeout",
    workDurationSeconds: 180,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  assert.equal(w.endReason, "work_duration_from_capped");
  assert.equal(w.windowSeconds, 5 + 180 + 5);
});

test("finalized_by_checkout 518s: cửa sổ = pre + 518 + buffer", () => {
  const w = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(518),
    timingStatus: "finalized_by_checkout",
    workDurationSeconds: 518,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  assert.equal(w.endReason, "work_ended");
  assert.equal(w.windowSeconds, 528);
});

test("đơn đóng cực nhanh được kéo lên sàn tối thiểu", () => {
  const w = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(3),
    timingStatus: "finalized_by_next_scan",
    workDurationSeconds: 3,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  assert.equal(w.endReason, "work_ended_extended_to_min");
  assert.equal(w.windowSeconds, 5 + 15);
});

test("work_ended vượt trần kỹ thuật thì bị cap, không cắt vô hạn", () => {
  const w = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(5000),
    timingStatus: "finalized_by_next_scan",
    workDurationSeconds: 5000,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  assert.equal(w.endReason, "capped_at_max_duration");
  assert.equal(w.windowSeconds, 5 + MAX_CLIP_DURATION_SECONDS);
});

test("work_ended sớm hơn scan (clock skew) rơi nhánh phòng thủ", () => {
  const w = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(-30),
    timingStatus: "finalized_by_next_scan",
    workDurationSeconds: null,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  assert.equal(w.endReason, "default_post_invalid_work_ended");
  assert.equal(w.windowSeconds, 65);
});

// ───────── Ước lượng theo segment thật ─────────

/** Chuỗi segment 60s liên tiếp, bắt đầu từ `fromSeconds` so với SCAN. */
function segments(
  fromSeconds: number,
  count: number,
  bytesPerSecond = KBPS_256,
): SegmentForEstimate[] {
  return Array.from({ length: count }, (_, i) => {
    const start = fromSeconds + i * 60;
    return {
      started_at: iso(start),
      ended_at: iso(start + 60),
      duration_seconds: 60,
      file_size_bytes: Math.round(60 * bytesPerSecond),
    };
  });
}

test("checkout 528s có segment phủ đủ → over_limit, cộng theo phần chồng lấn", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(518),
    timingStatus: "finalized_by_checkout",
    workDurationSeconds: 518,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  // Phủ từ -60s tới +600s = thừa hai đầu, phần chồng lấn mới được tính.
  const est = estimateProofSize({
    window,
    segments: segments(-60, 12),
    fallbackBytesPerSecond: KBPS_256,
    guardBytes: GUARD,
    warnBytes: WARN,
    correctionFactor: FACTOR,
  });

  assert.equal(est.estimate_method, "overlapping_segments");
  assert.equal(est.proof_size_risk, "over_limit");
  assert.equal(est.proof_window_seconds, 528);
  assert.equal(est.estimate_correction_factor, FACTOR);
  // 528s × 256 KB/s × 1.05 ≈ 139 MiB. Sai số nhỏ do làm tròn tỷ lệ chồng lấn.
  const expected = 528 * KBPS_256 * FACTOR;
  assert.ok(
    Math.abs((est.estimated_file_size_bytes ?? 0) - expected) < expected * 0.02,
    `ước tính ${est.estimated_file_size_bytes} lệch quá xa ${expected}`,
  );
  assert.ok((est.estimated_bitrate_kbps ?? 0) > 1900);
});

test("capped 190s @p50: safe sau khi nới trần (trước 2026-08-13 là near_limit)", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(600),
    timingStatus: "capped_timeout",
    workDurationSeconds: 180,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  const est = estimateProofSize({
    window,
    segments: segments(-60, 6),
    fallbackBytesPerSecond: KBPS_256,
    guardBytes: GUARD,
    warnBytes: WARN,
    correctionFactor: FACTOR,
  });
  assert.equal(est.estimate_method, "overlapping_segments");
  // 190s × 256 KB/s × 1.05 ≈ 49,9 MiB. E2E 2026-08-07 đo clip thật
  // 49,3 MiB, khớp bậc độ lớn — con số này KHÔNG đổi theo trần upload.
  const mib = (est.estimated_file_size_bytes ?? 0) / MIB;
  assert.ok(mib > 49 && mib < 50, `ước tính ${mib.toFixed(1)} MiB`);
  // Đây là ca chốt chặn của lần nới trần 2026-08-13: cùng clip này,
  // dưới guard 50/warn 49 cũ thì `near_limit` (cả bảng vàng), dưới
  // guard 90/warn 80 mới thì `safe`. Đơn capped 3 phút bình thường
  // không được coi là gần giới hạn nữa.
  assert.equal(est.proof_size_risk, "safe");
});

test("đơn ngắn → safe", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(40),
    timingStatus: "finalized_by_next_scan",
    workDurationSeconds: 40,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  const est = estimateProofSize({
    window,
    segments: segments(-60, 3),
    fallbackBytesPerSecond: KBPS_256,
    guardBytes: GUARD,
    warnBytes: WARN,
  });
  assert.equal(est.proof_size_risk, "safe");
});

// ───────── Fallback và nửa âm-đúng ─────────

test("segment phủ thiếu (camera tắt giữa chừng) → KHÔNG báo safe giả, rơi về p95", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(518),
    timingStatus: "finalized_by_checkout",
    workDurationSeconds: 518,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  // Chỉ 2 segment (120s) cho cửa sổ 528s → phủ ~23%.
  const est = estimateProofSize({
    window,
    segments: segments(-60, 2),
    fallbackBytesPerSecond: KBPS_256,
    guardBytes: GUARD,
    warnBytes: WARN,
  });
  assert.equal(est.estimate_method, "camera_recent_p95");
  assert.equal(est.proof_size_risk, "over_limit");
});

test("không segment, không lịch sử camera → unknown, không đoán bừa", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(518),
    timingStatus: "finalized_by_checkout",
    workDurationSeconds: 518,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  const est = estimateProofSize({
    window,
    segments: [],
    fallbackBytesPerSecond: null,
    guardBytes: GUARD,
    warnBytes: WARN,
  });
  assert.equal(est.estimate_method, "none");
  assert.equal(est.proof_size_risk, "unknown");
  assert.equal(est.estimated_file_size_bytes, null);
});

test("segment không chồng lấn cửa sổ thì không được cộng", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(40),
    timingStatus: "finalized_by_next_scan",
    workDurationSeconds: 40,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  // Segment nằm hoàn toàn sau cửa sổ.
  const est = estimateProofSize({
    window,
    segments: segments(600, 3),
    fallbackBytesPerSecond: null,
    guardBytes: GUARD,
    warnBytes: WARN,
  });
  assert.equal(est.estimate_method, "none");
  assert.equal(est.proof_size_risk, "unknown");
});

test("segment thiếu size hoặc thiếu mốc thời gian thì bị bỏ qua", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(40),
    timingStatus: "finalized_by_next_scan",
    workDurationSeconds: 40,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  const est = estimateProofSize({
    window,
    segments: [
      { started_at: iso(-10), ended_at: iso(50), duration_seconds: 60, file_size_bytes: null },
      { started_at: iso(-10), ended_at: null, duration_seconds: null, file_size_bytes: 999 },
    ],
    fallbackBytesPerSecond: null,
    guardBytes: GUARD,
    warnBytes: WARN,
  });
  assert.equal(est.estimate_method, "none");
});

// ───────── Phân loại và p95 ─────────

test("biên phân loại: safe < warn <= near_limit <= guard < over_limit", () => {
  assert.equal(classify(WARN - 1, GUARD, WARN), "safe");
  assert.equal(classify(WARN, GUARD, WARN), "near_limit");
  assert.equal(classify(GUARD, GUARD, WARN), "near_limit");
  assert.equal(classify(GUARD + 1, GUARD, WARN), "over_limit");
});

test("mặc định: guard 90 MiB, cảnh báo 80 MiB (trần project 100 MiB)", () => {
  // Bốn con số phải xếp đúng thứ tự, đổi một thì rà cả bốn:
  //   80 warn  <  90 guard  <  100 project  <  500 bucket.
  // Bucket 500 MB (giá trị THẬT trong DB, không phải 100 MiB như
  // migration tạo bucket ghi) nên nó không phải tầng cắn.
  // Guard đặt DƯỚI trần project là có chủ ý — clip 3 phút thật nặng
  // 45–50 MiB nên biên 10 MiB không chặn oan clip nào, mà vẫn giữ
  // agent là chỗ chặn đầu tiên (câu người đọc thay vì 413 thô).
  // Khác với ca 49/50 MiB hồi 2026-08-07: khi đó clip nằm ngay tại
  // ngưỡng nên biên an toàn = chặn oan 87,6% clip chạy được.
  const t = resolveProofSizeThresholds();
  assert.equal(t.guardBytes, 90 * MIB);
  assert.equal(t.warnBytes, 80 * MIB);
  assert.equal(t.warnNormalized, false);
  assert.ok(t.warnBytes < t.guardBytes);
  // Nửa còn lại của tính nhất quán: guard phải nằm dưới trần project,
  // nếu không guard mất tác dụng và 413 lại lọt ra ngoài.
  assert.ok(
    t.guardBytes < 100 * MIB,
    `guard ${t.guardBytes} phải dưới trần project 100 MiB`,
  );
});

test("hệ số hiệu chỉnh mặc định 1.05 và có mặt trong kết quả", () => {
  assert.equal(getProofSizeEstimateFactor(), 1.05);
});

test("file ĐÚNG BẰNG trần vẫn được coi là trong giới hạn", () => {
  // So sánh phải là `>`, không phải `>=`. Gốc từ phép đo trên gói Free:
  // 50 MiB → 200 OK, 51 MiB → 413. Giờ guard nằm dưới trần project nên
  // file đúng bằng guard lại càng upload được.
  const t = resolveProofSizeThresholds();
  assert.equal(classify(t.guardBytes, t.guardBytes, t.warnBytes), "near_limit");
  assert.equal(
    classify(t.guardBytes + 1, t.guardBytes, t.warnBytes),
    "over_limit",
  );
});

test("cấu hình sai thứ tự: warn >= guard bị kẹp xuống dưới guard", () => {
  // Ca thật: ops hạ upload guard xuống 45 MiB nhưng quên warn 48 MiB.
  const prevGuard = process.env.MAX_PROOF_CLIP_UPLOAD_BYTES;
  const prevWarn = process.env.PROOF_CLIP_WARN_BYTES;
  try {
    process.env.MAX_PROOF_CLIP_UPLOAD_BYTES = String(45 * MIB);
    process.env.PROOF_CLIP_WARN_BYTES = String(48 * MIB);
    const t = resolveProofSizeThresholds();
    assert.equal(t.guardBytes, 45 * MIB);
    assert.equal(t.warnNormalized, true);
    assert.ok(
      t.warnBytes < t.guardBytes,
      `warn ${t.warnBytes} phải thấp hơn guard ${t.guardBytes}`,
    );
    assert.equal(t.warnBytes, 44 * MIB);
    // Nửa âm-đúng: phân loại vẫn còn nghĩa sau khi kẹp.
    assert.equal(classify(43 * MIB, t.guardBytes, t.warnBytes), "safe");
    assert.equal(classify(44 * MIB, t.guardBytes, t.warnBytes), "near_limit");
    assert.equal(classify(46 * MIB, t.guardBytes, t.warnBytes), "over_limit");
  } finally {
    if (prevGuard === undefined) delete process.env.MAX_PROOF_CLIP_UPLOAD_BYTES;
    else process.env.MAX_PROOF_CLIP_UPLOAD_BYTES = prevGuard;
    if (prevWarn === undefined) delete process.env.PROOF_CLIP_WARN_BYTES;
    else process.env.PROOF_CLIP_WARN_BYTES = prevWarn;
  }
});

test("guard quá nhỏ: warn không được rơi về 0 (mọi clip thành near_limit)", () => {
  const prevGuard = process.env.MAX_PROOF_CLIP_UPLOAD_BYTES;
  const prevWarn = process.env.PROOF_CLIP_WARN_BYTES;
  try {
    process.env.MAX_PROOF_CLIP_UPLOAD_BYTES = String(MIB);
    process.env.PROOF_CLIP_WARN_BYTES = String(48 * MIB);
    const t = resolveProofSizeThresholds();
    assert.ok(t.warnBytes > 0, `warn=${t.warnBytes} phải lớn hơn 0`);
    assert.ok(t.warnBytes < t.guardBytes);
  } finally {
    if (prevGuard === undefined) delete process.env.MAX_PROOF_CLIP_UPLOAD_BYTES;
    else process.env.MAX_PROOF_CLIP_UPLOAD_BYTES = prevGuard;
    if (prevWarn === undefined) delete process.env.PROOF_CLIP_WARN_BYTES;
    else process.env.PROOF_CLIP_WARN_BYTES = prevWarn;
  }
});

test("ở ngưỡng mặc định, clip capped 190s @p50 nằm an toàn dưới warn", () => {
  const window = computeFinalizedClipWindow({
    scannedAt: SCAN,
    workEndedAt: iso(600),
    timingStatus: "capped_timeout",
    workDurationSeconds: 180,
    preSeconds: 5,
    defaultPostSeconds: 60,
  });
  const t = resolveProofSizeThresholds();
  const est = estimateProofSize({
    window,
    segments: segments(-60, 6),
    fallbackBytesPerSecond: KBPS_256,
    guardBytes: t.guardBytes,
    warnBytes: t.warnBytes,
  });
  // Dùng hệ số mặc định (không truyền correctionFactor) — đây là ca
  // kiểm cấu hình production thật, không phải số cố định của test.
  //
  // Trước 2026-08-13 ca này là `near_limit` và đó là sự thật: đơn capped
  // bình thường chạy ở ~99% trần 50 MiB. Sau khi nới trần lên 100 MiB,
  // cùng clip ấy phải về `safe` — nếu ca này lại vàng thì hoặc bitrate
  // camera đã tăng, hoặc ai đó hạ ngưỡng, chứ không phải chuyện bình
  // thường.
  assert.equal(est.proof_size_risk, "safe");
});

test("p95 bỏ qua file thiếu dữ liệu và nghiêng về phía nặng", () => {
  assert.equal(percentile95BytesPerSecond([]), null);
  assert.equal(
    percentile95BytesPerSecond([
      { duration_seconds: 0, file_size_bytes: 100 },
      { duration_seconds: 60, file_size_bytes: null },
    ]),
    null,
  );
  const rates = Array.from({ length: 100 }, (_, i) => ({
    duration_seconds: 60,
    file_size_bytes: (i + 1) * 60,
  }));
  const p95 = percentile95BytesPerSecond(rates);
  assert.ok(p95 !== null && p95 >= 95 && p95 <= 100, `p95=${p95}`);
});
