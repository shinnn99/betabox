import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vnDateKey,
  shiftDateKey,
  formatDateKeyVn,
} from "../src/lib/time/vietnam.ts";
import {
  vietnamDayUtcRange,
  vietnamTodayKey,
  resolveVietnamDayScope,
} from "../src/lib/warehouse/time-range.ts";

/**
 * Bó "một ngày VN" cho bảng giám sát đóng hàng.
 *
 * Chạy:
 *   TZ=UTC node --conditions=react-server --experimental-strip-types \
 *     --test tests/warehouse-day-scope.test.ts
 *
 * TZ=UTC là môi trường Vercel — cũng chính là nơi mọi lỗi lệch -7 giờ nổ.
 * `--conditions=react-server` để `import "server-only"` trong time-range.ts
 * resolve về module rỗng thay vì throw; giữ nguyên chốt chặn đó cho app.
 */

test("nửa 'cách cũ PHẢI sai': toISOString().slice(0,10) trả nhầm ngày ca sáng sớm", () => {
  // 01:00 ngày 08/08 giờ VN.
  const iso = "2026-08-07T18:00:00.000Z";
  assert.equal(iso.slice(0, 10), "2026-08-07"); // ngày UTC — hôm QUA theo VN
  assert.equal(vnDateKey(iso), "2026-08-08"); // ngày VN — đúng
});

test("vnDateKey bám ranh giới nửa đêm VN (17:00Z)", () => {
  assert.equal(vnDateKey("2026-08-07T16:59:59.999Z"), "2026-08-07");
  assert.equal(vnDateKey("2026-08-07T17:00:00.000Z"), "2026-08-08");
});

test("vietnamTodayKey khớp vnDateKey trên cùng một instant", () => {
  for (const iso of [
    "2026-08-07T16:59:59.999Z",
    "2026-08-07T17:00:00.000Z",
    "2026-12-31T17:00:00.000Z",
  ]) {
    assert.equal(vietnamTodayKey(new Date(iso)), vnDateKey(iso), iso);
  }
});

test("vietnamDayUtcRange trả đúng cửa sổ 24h bắt đầu 17:00Z hôm trước", () => {
  const r = vietnamDayUtcRange("2026-08-07");
  assert.deepEqual(r, {
    startIso: "2026-08-06T17:00:00.000Z",
    endIso: "2026-08-07T17:00:00.000Z",
  });
});

test("cửa sổ liền kề không hở và không chồng", () => {
  const d7 = vietnamDayUtcRange("2026-08-07");
  const d8 = vietnamDayUtcRange("2026-08-08");
  assert.equal(d7?.endIso, d8?.startIso);
});

test("một instant chỉ thuộc đúng một ngày VN", () => {
  const instant = "2026-08-07T17:00:00.000Z"; // 00:00 ngày 08/08 VN
  const day = vietnamDayUtcRange(vnDateKey(instant))!;
  // Query dùng .gte(start).lt(end) → biên trái đóng, biên phải mở.
  assert.ok(instant >= day.startIso && instant < day.endIso);
  const prev = vietnamDayUtcRange("2026-08-07")!;
  assert.ok(!(instant >= prev.startIso && instant < prev.endIso));
});

test("ngày không có thật bị bác chứ KHÔNG cuộn sang ngày khác", () => {
  // Date.UTC(2026, 1, 31) tự cuộn sang 03/03 — nếu không round-trip kiểm
  // lại thì người gõ 31/02 nhận dữ liệu ngày 03/03 mà không hề biết.
  assert.equal(vietnamDayUtcRange("2026-02-31"), null);
  assert.equal(vietnamDayUtcRange("2026-13-01"), null);
  assert.equal(vietnamDayUtcRange("2026-00-10"), null);
  assert.equal(vietnamDayUtcRange("2026-8-7"), null); // thiếu số 0
  assert.equal(vietnamDayUtcRange("hôm qua"), null);
  assert.equal(vietnamDayUtcRange(""), null);
});

test("ngày nhuận thật vẫn được chấp nhận", () => {
  assert.notEqual(vietnamDayUtcRange("2028-02-29"), null);
  assert.equal(vietnamDayUtcRange("2026-02-29"), null);
});

test("resolveVietnamDayScope: thiếu param → hôm nay, không đánh dấu lỗi", () => {
  const s = resolveVietnamDayScope(null);
  assert.equal(s.invalidDate, false);
  assert.equal(s.dateKey, vietnamTodayKey());
});

test("resolveVietnamDayScope: ngày rác → rơi về hôm nay VÀ nói ra", () => {
  const s = resolveVietnamDayScope("2026-02-31");
  assert.equal(s.invalidDate, true);
  assert.equal(s.dateKey, vietnamTodayKey());
});

test("resolveVietnamDayScope: ngày hợp lệ giữ nguyên", () => {
  const s = resolveVietnamDayScope("2026-08-07");
  assert.equal(s.invalidDate, false);
  assert.equal(s.dateKey, "2026-08-07");
  assert.equal(s.startIso, "2026-08-06T17:00:00.000Z");
});

test("shiftDateKey qua biên tháng, biên năm và năm nhuận", () => {
  assert.equal(shiftDateKey("2026-08-07", -1), "2026-08-06");
  assert.equal(shiftDateKey("2026-08-01", -1), "2026-07-31");
  assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDateKey("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftDateKey("2026-02-28", 1), "2026-03-01");
});

test("shiftDateKey luôn sinh ra khoá mà vietnamDayUtcRange chấp nhận", () => {
  let key = "2026-01-01";
  for (let i = 0; i < 400; i++) {
    key = shiftDateKey(key, 1);
    assert.notEqual(vietnamDayUtcRange(key), null, key);
  }
  assert.equal(key, "2027-02-05");
});

test("formatDateKeyVn hiển thị dd/MM/yyyy", () => {
  assert.equal(formatDateKeyVn("2026-08-07"), "07/08/2026");
});
