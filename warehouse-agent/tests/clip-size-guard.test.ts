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
 *
 * Verify HAI NỬA:
 *   - nửa dương-đúng: clip vượt trần → BỊ chặn, kèm đủ số chẩn đoán.
 *   - nửa âm-đúng: clip trong trần (kể cả sát mép) → KHÔNG bị đụng.
 */

const MIB = 1024 * 1024;
/**
 * Mặc định config.maxProofClipUploadBytes.
 *
 * 2026-08-07 (gói Free): trần project đo bằng PUT thật là 50 MiB
 * (50 OK / 51 → 413) và guard để ĐÚNG 50 MiB. Bản đầu để 49 MiB, E2E
 * production bác bỏ — clip capped 190s thật nặng 49,3 MiB upload OK
 * nhưng bị chặn oan; áp phân bố bitrate thật thì 49 MiB từ chối 87,6%
 * clip chạy được trong khi chỉ 7,0% thật sự vượt.
 *
 * 2026-08-13 (gói trả phí): project nâng lên 100 MiB (đo lại cùng cách:
 * 100 MiB → 200 OK, 101 MiB → 413), guard về 90 MiB.
 * Bitrate camera KHÔNG đổi, nên mọi ca dưới đây giữ nguyên byte thật —
 * chỉ khoảng cách tới trần là đổi.
 */
const LIMIT = 90 * MIB;

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

test("ca E2E THẬT 2026-08-07: clip 194s nặng 49,3 MiB → PHẢI cho upload", () => {
  // Số đo thật, không dựng: SPXVN064759877478 cắt ra 194s / 51.694.899
  // byte, upload OK, promote ready, playback OK. Guard 49 MiB cũ đã chặn
  // đúng file này — đây là ca chốt chặn hồi quy cho quyết định đó.
  const size = Math.round(49.3 * MIB);
  assert.equal(
    evaluateClipSize({ fileSizeBytes: size, durationSeconds: 194, limitBytes: LIMIT }),
    null,
    "clip đã chứng minh upload được không được phép bị guard chặn",
  );
});

test("ca 190s/capped ở bitrate MAX 265KB/s → còn headroom rõ, không sát mép", () => {
  // Đây là ca chốt chặn của lần nới trần 2026-08-13. Dưới trần 50 MiB
  // cũ, clip capped tệ nhất nặng ~49,2 MiB — lọt, nhưng chỉ dư ~0,8 MiB,
  // nên bitrate nhích lên một chút là 413. Trần mới phải cho dư nhiều
  // hơn thế hẳn, nếu không thì việc nới trần chẳng giải quyết gì.
  const size = clipBytes(190, 265);
  assert.equal(
    evaluateClipSize({ fileSizeBytes: size, durationSeconds: 190, limitBytes: LIMIT }),
    null,
  );
  const headroomMib = (LIMIT - size) / MIB;
  assert.ok(
    headroomMib > 30,
    `clip capped tệ nhất phải còn dư nhiều, thực tế ${headroomMib.toFixed(1)} MiB`,
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

test("biên: đúng bằng ngưỡng → CHO upload (so sánh `>`, không `>=`)", () => {
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
