import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOpenSegments,
  OPEN_SEGMENT_MAX_AGE_SECONDS,
} from "../src/lib/order-proof/open-segment-verdict.ts";

/**
 * Bug gốc (2026-09-04, kho Đại Kim): 1 row `ended_at IS NULL` từ 27/08
 * chặn cắt clip cho MỌI đơn sau đó — 92 đơn liên tiếp.
 *
 * Test phải phủ HAI VẾ, không được chỉ chứng minh vế "hết chặn":
 *   dương-đúng: segment đang ghi thật thì VẪN chặn (không cắt clip hỏng)
 *   âm-đúng:    row mồ côi cũ thì KHÔNG chặn
 * Chỉ có vế thứ hai là fix quá tay — mở cửa cho clip cụt đuôi.
 */

const clipEnd = new Date("2026-09-04T08:53:32.000Z");

function open(startedAt: string) {
  return { started_at: startedAt, ended_at: null };
}
function closed(startedAt: string, endedAt: string) {
  return { started_at: startedAt, ended_at: endedAt };
}

// ---------- VẾ DƯƠNG: vẫn phải chặn khi segment đang ghi thật ----------

test("segment đang ghi (mở ngay trước clipEnd) → VẪN chặn", () => {
  // Đúng ca mà luật cũ sinh ra để bảo vệ: ffmpeg vừa mở file lúc
  // 08:53:08, đơn kết thúc 08:53:32 → đuôi chưa flush.
  const v = evaluateOpenSegments([open("2026-09-04T08:53:08.000Z")], clipEnd);
  assert.equal(v.blocking, true);
  assert.equal(v.staleOpen.length, 0);
});

test("row open ngay tại ngưỡng tuổi → vẫn chặn (biên đóng)", () => {
  const startedMs = clipEnd.getTime() - OPEN_SEGMENT_MAX_AGE_SECONDS * 1000;
  const v = evaluateOpenSegments([open(new Date(startedMs).toISOString())], clipEnd);
  assert.equal(v.blocking, true);
});

test("started_at không parse được → chặn (không dám đoán mồ côi)", () => {
  const v = evaluateOpenSegments([open("not-a-date")], clipEnd);
  assert.equal(v.blocking, true);
  assert.equal(v.staleOpen.length, 0);
});

test("có CẢ mồ côi lẫn segment đang ghi → chặn vì cái đang ghi", () => {
  const v = evaluateOpenSegments(
    [open("2026-08-27T07:25:31.000Z"), open("2026-09-04T08:53:08.000Z")],
    clipEnd,
  );
  assert.equal(v.blocking, true);
  assert.equal(v.staleOpen.length, 1, "vẫn báo cáo row mồ côi để ops thấy");
});

// ---------- VẾ ÂM: không được chặn khi chỉ có row mồ côi ----------

test("row mồ côi 8 ngày tuổi (bug thật) → KHÔNG chặn", () => {
  // Đúng row đã cắn: dahua_01/2026/08/27/dahua_01_20260827_142531.mp4
  const v = evaluateOpenSegments([open("2026-08-27T07:25:31.000Z")], clipEnd);
  assert.equal(v.blocking, false);
  assert.equal(v.staleOpen.length, 1);
  assert.equal(v.staleOpen[0].started_at, "2026-08-27T07:25:31.000Z");
});

test("row mồ côi vừa quá ngưỡng → không chặn", () => {
  const startedMs = clipEnd.getTime() - (OPEN_SEGMENT_MAX_AGE_SECONDS + 1) * 1000;
  const v = evaluateOpenSegments([open(new Date(startedMs).toISOString())], clipEnd);
  assert.equal(v.blocking, false);
  assert.equal(v.staleOpen.length, 1);
});

test("mồ côi + segment đã đóng phủ cửa sổ → không chặn, cắt được", () => {
  // Đúng hình dạng dữ liệu của đơn 862383607694.
  const v = evaluateOpenSegments(
    [
      open("2026-08-27T07:25:31.000Z"),
      closed("2026-09-04T08:52:09.000Z", "2026-09-04T08:53:08.000Z"),
      closed("2026-09-04T08:53:08.000Z", "2026-09-04T08:54:09.000Z"),
    ],
    clipEnd,
  );
  assert.equal(v.blocking, false);
  assert.equal(v.staleOpen.length, 1);
});

// ---------- Ca vốn đã đúng, giữ nguyên hành vi ----------

test("row open bắt đầu SAU clipEnd → không chặn, không tính mồ côi", () => {
  const v = evaluateOpenSegments([open("2026-09-04T09:38:08.000Z")], clipEnd);
  assert.equal(v.blocking, false);
  assert.equal(v.staleOpen.length, 0, "chưa tới lượt nó, không phải mồ côi");
});

test("toàn segment đã đóng → không chặn", () => {
  const v = evaluateOpenSegments(
    [closed("2026-09-04T08:52:09.000Z", "2026-09-04T08:53:08.000Z")],
    clipEnd,
  );
  assert.equal(v.blocking, false);
  assert.equal(v.staleOpen.length, 0);
});

test("danh sách rỗng → không chặn", () => {
  const v = evaluateOpenSegments([], clipEnd);
  assert.equal(v.blocking, false);
  assert.equal(v.staleOpen.length, 0);
});
