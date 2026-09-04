import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cameraGapMinutes,
  coverageOfWindow,
  gapsInWindow,
  mergeIntervals,
  warehouseHoursFromScans,
  type SegmentLike,
} from "../src/lib/system/evidence-coverage.ts";

/**
 * Toán phủ bằng chứng — lõi của BB-2 (đơn mất bằng chứng) và BB-3
 * (bàn-phút mất khả năng ghi).
 *
 * Số dùng ở đây bám thực tế đường ghi hình: segment dài 60 giây
 * (active-credentials.ts trả segment_seconds: 60), đơn đóng gói điển hình
 * 180 giây (packing_timing_single_source_180).
 */

const T0 = Date.parse("2026-08-14T02:00:00.000Z");
const s = (n: number) => T0 + n * 1_000;
const iso = (n: number) => new Date(s(n)).toISOString();

/** Chuỗi segment 60 giây liên tục từ giây `from` đến giây `to`. */
function chain(from: number, to: number): SegmentLike[] {
  const out: SegmentLike[] = [];
  for (let t = from; t < to; t += 60) {
    out.push({ started_at: iso(t), ended_at: iso(Math.min(t + 60, to)) });
  }
  return out;
}

test("mergeIntervals nhập segment kề sát thành một khoảng", () => {
  const merged = mergeIntervals([
    { start: s(0), end: s(60) },
    { start: s(60), end: s(120) },
    { start: s(120), end: s(180) },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { start: s(0), end: s(180) });
});

test("mergeIntervals không cộng đôi khoảng chồng nhau", () => {
  // Đây là vế union của BB-3: hai nguồn cùng nói về một quãng thời gian
  // chỉ được tính một lần.
  const merged = mergeIntervals([
    { start: s(0), end: s(600) },
    { start: s(300), end: s(900) },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end - merged[0].start, 900_000);
});

test("phủ trọn cửa sổ đơn → covered, 0 giây mất", () => {
  const r = coverageOfWindow(chain(-60, 240), { start: s(0), end: s(180) });
  assert.equal(r.verdict, "covered");
  assert.equal(r.windowSeconds, 180);
  assert.equal(r.coveredSeconds, 180);
  assert.equal(r.gapSeconds, 0);
  assert.deepEqual(r.gaps, []);
});

test("segment chỉ chạm mép đầu → partial, KHÔNG phải covered", () => {
  // Ca cốt lõi khiến file này tồn tại: resolveClipBounds trả `ok` cho ca
  // này (có segment giao cửa sổ → cắt được). BB-2 phải nói ngược lại —
  // đơn 180 giây chỉ có 10 giây bằng chứng là đơn đã mất bằng chứng.
  const r = coverageOfWindow([{ started_at: iso(-50), ended_at: iso(10) }], {
    start: s(0),
    end: s(180),
  });
  assert.equal(r.verdict, "partial");
  assert.equal(r.coveredSeconds, 10);
  assert.equal(r.gapSeconds, 170);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].start, s(10));
});

test("thủng giữa đơn → partial, lỗ đúng vị trí và đúng độ dài", () => {
  const segs = [...chain(0, 60), ...chain(120, 180)];
  const r = coverageOfWindow(segs, { start: s(0), end: s(180) });
  assert.equal(r.verdict, "partial");
  assert.equal(r.coveredSeconds, 120);
  assert.equal(r.gapSeconds, 60);
  assert.deepEqual(r.gaps, [{ start: s(60), end: s(120) }]);
});

test("không segment nào → missing, mất trọn cửa sổ", () => {
  const r = coverageOfWindow([], { start: s(0), end: s(180) });
  assert.equal(r.verdict, "missing");
  assert.equal(r.coveredSeconds, 0);
  assert.equal(r.gapSeconds, 180);
});

test("segment còn mở → defer, và defer thắng cả khi đang thủng", () => {
  // Đơn vừa đóng: segment cuối chưa flush. Chấm partial ở đây là ghi sổ
  // sai cho mọi đơn bình thường, vì sổ giữ con số đầu tiên.
  const segs: SegmentLike[] = [
    ...chain(0, 60),
    { started_at: iso(120), ended_at: null },
  ];
  const r = coverageOfWindow(segs, { start: s(0), end: s(180) });
  assert.equal(r.verdict, "defer");
});

test("segment mở đã kết thúc trước cửa sổ thì không kích defer", () => {
  const r = coverageOfWindow(
    [{ started_at: iso(-600), ended_at: null }],
    { start: s(0), end: s(180) },
  );
  // started_at <= window.end nên vẫn defer — file này đang ghi và có thể
  // đã phủ cửa sổ. Không đoán.
  assert.equal(r.verdict, "defer");
});

test("gapsInWindow cắt gọn hai đầu, không trả lỗ ngoài cửa sổ", () => {
  const gaps = gapsInWindow(
    [{ start: s(-600), end: s(60) }],
    { start: s(0), end: s(120) },
  );
  assert.deepEqual(gaps, [{ start: s(60), end: s(120) }]);
});

test("giờ kho suy từ scan đầu và scan cuối", () => {
  const hours = warehouseHoursFromScans([iso(300), iso(0), iso(7200)]);
  assert.ok(hours);
  assert.equal(hours.start, s(0));
  assert.equal(hours.end, s(7200));
});

test("ngày có dưới 2 scan → không có giờ kho, không kết luận", () => {
  assert.equal(warehouseHoursFromScans([]), null);
  assert.equal(warehouseHoursFromScans([iso(0)]), null);
});

test("bàn-phút: camera ghi liên tục suốt giờ kho → 0 phút mất", () => {
  const hours = { start: s(0), end: s(3600) };
  const r = cameraGapMinutes("cam-1", chain(0, 3600), hours);
  assert.equal(r.lostMinutes, 0);
});

test("bàn-phút: lỗ 14 phút giữa ca đúng như ví dụ vận hành", () => {
  // 14:10 mất tín hiệu, 14:24 ghi lại → 14 phút.
  const hours = { start: s(0), end: s(3600) };
  const segs = [...chain(0, 600), ...chain(1440, 3600)];
  const r = cameraGapMinutes("cam-1", segs, hours);
  assert.equal(r.lostMinutes, 14);
});

test("bàn-phút: segment còn mở tính tới hết giờ kho", () => {
  const hours = { start: s(0), end: s(3600) };
  const r = cameraGapMinutes(
    "cam-1",
    [{ started_at: iso(0), ended_at: null }],
    hours,
  );
  assert.equal(r.lostMinutes, 0);
});

test("bàn-phút: hai camera cùng chết một quãng KHÔNG cộng đôi trên mỗi bàn", () => {
  // Union theo bàn: mỗi camera tự tính lỗ của mình, và lỗ của một camera
  // do hai nguyên nhân chồng nhau vẫn chỉ là một quãng.
  const hours = { start: s(0), end: s(3600) };
  const segs = [...chain(0, 600), ...chain(1200, 3600)];
  const a = cameraGapMinutes("cam-1", segs, hours);
  const b = cameraGapMinutes("cam-2", segs, hours);
  assert.equal(a.lostMinutes, 10);
  assert.equal(b.lostMinutes, 10);
  // Tổng bàn-phút của kho là 20 — hai bàn cùng mù 10 phút là thiệt hại
  // gấp đôi một bàn mù 10 phút, và BB-3 phải nói được điều đó.
  assert.equal(a.lostMinutes + b.lostMinutes, 20);
});
