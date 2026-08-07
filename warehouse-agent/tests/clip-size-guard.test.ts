import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateClipSize,
  computeClipBitrateKbps,
} from "../src/clip-size-guard";

/**
 * Guard dung lượng proof clip.
 *
 * Số dùng trong test KHÔNG bịa: bitrate lấy từ 4441 segment thật của
 * camera `Dahua 01` (kho Đại Kim, 14 ngày tới 2026-08-07):
 *   min 244 KB/s · p50 256 KB/s · p95 260 KB/s · max 265 KB/s
 * Trần upload lấy từ phép đo PUT thật: 50 MiB OK, 51 MiB → 413.
 *
 * Verify HAI NỬA:
 *   - nửa dương-đúng: clip vượt trần → BỊ chặn, kèm đủ số chẩn đoán.
 *   - nửa âm-đúng: clip trong trần (kể cả sát mép) → KHÔNG bị đụng.
 */

const MIB = 1024 * 1024;
const LIMIT = 49 * MIB; // mặc định config.maxProofClipUploadBytes
const HARD_LIMIT = 50 * MIB; // trần thật đo được của project

/** Bytes của clip `seconds` giây ở `kbPerSec` KB/s. */
function clipBytes(seconds: number, kbPerSec: number): number {
  return Math.round(seconds * kbPerSec * 1024);
}

test("ca 190s/capped ở bitrate p50 → CHO upload (không chặn nhầm clip hợp lệ)", () => {
  // capped_timeout: 5s pre + 180s body + 5s buffer = 190s.
  const size = clipBytes(190, 256);
  assert.ok(size < LIMIT, `mong đợi dưới trần, thực tế ${size} vs ${LIMIT}`);
  assert.equal(evaluateClipSize({ fileSizeBytes: size, durationSeconds: 190, limitBytes: LIMIT }), null);
});

test("ca 190s/capped ở bitrate MAX 265KB/s → vẫn dưới trần cứng 50MiB", () => {
  // Đây là lý do KHÔNG đặt guard ở 45–47MB: mép trên của clip capped
  // hợp lệ là ~49,2MB, guard thấp hơn sẽ từ chối chính nó.
  const size = clipBytes(190, 265);
  assert.ok(
    size < HARD_LIMIT,
    `clip capped tệ nhất phải vẫn upload được: ${size} vs ${HARD_LIMIT}`,
  );
});

test("ca 518s/checkout → BỊ chặn, kèm size/duration/bitrate", () => {
  // Đơn dài nhất đóng bằng ra ca ở Đại Kim: work_duration_seconds=518.
  const size = clipBytes(518, 256);
  const rejection = evaluateClipSize({
    fileSizeBytes: size,
    durationSeconds: 518,
    limitBytes: LIMIT,
  });
  assert.ok(rejection, "clip 518s phải bị chặn");
  assert.match(rejection.message, /proof_clip_too_large/);
  assert.equal(rejection.metadata.file_size_bytes, size);
  assert.equal(rejection.metadata.duration_seconds, 518);
  assert.equal(rejection.metadata.limit_bytes, LIMIT);
  assert.ok(
    rejection.metadata.bitrate_kbps > 1000,
    `bitrate phải có số thật, nhận ${rejection.metadata.bitrate_kbps}`,
  );
});

test("biên: đúng bằng trần → CHO upload (đã verify 50MiB chẵn trả 200)", () => {
  assert.equal(
    evaluateClipSize({ fileSizeBytes: LIMIT, durationSeconds: 190, limitBytes: LIMIT }),
    null,
  );
});

test("biên: hơn trần 1 byte → BỊ chặn", () => {
  const rejection = evaluateClipSize({
    fileSizeBytes: LIMIT + 1,
    durationSeconds: 190,
    limitBytes: LIMIT,
  });
  assert.ok(rejection, "hơn trần 1 byte phải bị chặn");
});

test("duration = 0 không làm vỡ phép chia — bitrate về 0, vẫn chặn được", () => {
  assert.equal(computeClipBitrateKbps(1000, 0), 0);
  const rejection = evaluateClipSize({
    fileSizeBytes: LIMIT + 1,
    durationSeconds: 0,
    limitBytes: LIMIT,
  });
  assert.ok(rejection);
  assert.equal(rejection.metadata.bitrate_kbps, 0);
  assert.equal(rejection.metadata.duration_seconds, 0);
});
