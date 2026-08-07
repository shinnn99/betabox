import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalizedClipWindow,
  MAX_CLIP_DURATION_SECONDS,
} from "../src/lib/order-proof/clip-window";
import {
  classify,
  estimateProofSize,
  getProofSizeWarnBytes,
  getProofUploadGuardBytes,
  percentile95BytesPerSecond,
  type SegmentForEstimate,
} from "../src/lib/order-proof/proof-size-estimate";

/**
 * Cửa sổ clip + ước lượng dung lượng proof.
 *
 * Số dùng ở đây lấy từ dữ liệu thật kho Đại Kim (2026-08-07): camera
 * Dahua 01 ~256 KB/s trên 4441 segment, segment dài 60s, trần upload đo
 * được 50 MiB (guard mặc định 49 MiB, cảnh báo 47 MiB).
 */

const MIB = 1024 * 1024;
const GUARD = 49 * MIB;
const WARN = 47 * MIB;
const KBPS_256 = 256 * 1024; // byte/giây

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
  });

  assert.equal(est.estimate_method, "overlapping_segments");
  assert.equal(est.proof_size_risk, "over_limit");
  assert.equal(est.proof_window_seconds, 528);
  // 528s × 256 KB/s ≈ 132 MiB. Cho sai số nhỏ do làm tròn tỷ lệ chồng lấn.
  const expected = 528 * KBPS_256;
  assert.ok(
    Math.abs((est.estimated_file_size_bytes ?? 0) - expected) < expected * 0.02,
    `ước tính ${est.estimated_file_size_bytes} lệch quá xa ${expected}`,
  );
  assert.ok((est.estimated_bitrate_kbps ?? 0) > 1900);
});

test("capped 190s có segment phủ đủ → near_limit, KHÔNG phải over_limit", () => {
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
  });
  assert.equal(est.estimate_method, "overlapping_segments");
  // 190s × 256 KB/s ≈ 47,5 MiB → giữa ngưỡng cảnh báo 47 và guard 49.
  assert.equal(est.proof_size_risk, "near_limit");
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

test("mặc định: guard 49 MiB, cảnh báo 48 MiB", () => {
  // 48 chứ không phải 47: đo trên 4491 segment thật của Đại Kim, ngưỡng
  // 47 MiB bôi vàng 89% clip capped 190s — cảnh báo mất hết ý nghĩa.
  assert.equal(getProofUploadGuardBytes(), 49 * MIB);
  assert.equal(getProofSizeWarnBytes(), 48 * MIB);
  assert.ok(getProofSizeWarnBytes() < getProofUploadGuardBytes());
});

test("ở ngưỡng mặc định, clip capped 190s @p50 KHÔNG còn là amber", () => {
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
    guardBytes: getProofUploadGuardBytes(),
    warnBytes: getProofSizeWarnBytes(),
  });
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
