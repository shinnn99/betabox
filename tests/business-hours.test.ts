import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeOperatingHours,
  isWithinOperatingHours,
  mergeOperatingHours,
  operatingMsBetween,
  parseOperatingHours,
  type OperatingHours,
} from "../src/lib/system/business-hours.ts";

/**
 * Giờ vận hành kho.
 *
 * Mọi mốc thời gian dưới đây là mốc THẬT lấy từ dữ liệu kho Đại Kim
 * (bảng camera_recording_files, 24/07→12/08/2026) chứ không phải số bịa:
 * kho chạy T2–T7, segment đầu ngày 08:21–10:31, segment cuối 16:22–18:31,
 * ba Chủ nhật liên tiếp không có segment nào.
 *
 * Asia/Bangkok = UTC+7, không DST — nên mọi mốc UTC ở đây cộng 7 là ra
 * giờ Việt Nam.
 */

const HOURS: OperatingHours = parseOperatingHours({
  timezone: "Asia/Bangkok",
  start: "09:30",
  end: "16:00",
  days: [1, 2, 3, 4, 5, 6],
})!;

const MIN = 60_000;

// ═══════════════════════════════════════════════════════════════════════
// Đọc cấu hình
// ═══════════════════════════════════════════════════════════════════════

test("parse: cấu hình hợp lệ", () => {
  assert.ok(HOURS);
  assert.equal(HOURS.timezone, "Asia/Bangkok");
  assert.equal(HOURS.startMinute, 9 * 60 + 30);
  assert.equal(HOURS.endMinute, 16 * 60);
  assert.deepEqual(HOURS.days, [1, 2, 3, 4, 5, 6]);
});

test("parse: mọi kiểu hỏng đều ra null (caller sẽ ngả về 24/7)", () => {
  const bad: unknown[] = [
    null,
    "09:30-16:00",
    [],
    {},
    { timezone: "Asia/Bangkok", start: "09:30", end: "16:00" }, // thiếu days
    { timezone: "Asia/Bangkok", start: "09:30", days: [1] }, // thiếu end
    { timezone: "Khong/Co_That", start: "09:30", end: "16:00", days: [1] },
    { timezone: "Asia/Bangkok", start: "9h30", end: "16:00", days: [1] },
    { timezone: "Asia/Bangkok", start: "25:00", end: "26:00", days: [1] },
    { timezone: "Asia/Bangkok", start: "09:30", end: "09:30", days: [1] }, // rỗng
    { timezone: "Asia/Bangkok", start: "16:00", end: "09:30", days: [1] }, // ca đêm
    { timezone: "Asia/Bangkok", start: "09:30", end: "16:00", days: [] },
    { timezone: "Asia/Bangkok", start: "09:30", end: "16:00", days: [0] },
    { timezone: "Asia/Bangkok", start: "09:30", end: "16:00", days: [8] },
    { timezone: "Asia/Bangkok", start: "09:30", end: "16:00", days: ["T2"] },
  ];
  for (const raw of bad) {
    assert.equal(parseOperatingHours(raw), null, `phải null: ${JSON.stringify(raw)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Trong giờ hay ngoài giờ
// ═══════════════════════════════════════════════════════════════════════

test("isWithin: biên đóng đầu, mở cuối", () => {
  // 09:29 T2 → chưa; 09:30 → rồi; 15:59 → còn; 16:00 → hết.
  assert.equal(isWithinOperatingHours(new Date("2026-08-10T02:29:00Z"), HOURS), false);
  assert.equal(isWithinOperatingHours(new Date("2026-08-10T02:30:00Z"), HOURS), true);
  assert.equal(isWithinOperatingHours(new Date("2026-08-10T08:59:00Z"), HOURS), true);
  assert.equal(isWithinOperatingHours(new Date("2026-08-10T09:00:00Z"), HOURS), false);
});

test("isWithin: Chủ nhật luôn ngoài giờ dù đúng khung giờ", () => {
  // 09/08/2026 là Chủ nhật, 12:00 trưa giờ VN.
  assert.equal(isWithinOperatingHours(new Date("2026-08-09T05:00:00Z"), HOURS), false);
});

test("isWithin: 20:00 tối — đúng khoảnh khắc bản cũ bắn tin Lark", () => {
  assert.equal(isWithinOperatingHours(new Date("2026-08-12T13:00:00Z"), HOURS), false);
});

// ═══════════════════════════════════════════════════════════════════════
// Im lặng trong giờ — hàm trung tâm
// ═══════════════════════════════════════════════════════════════════════

test("operatingMsBetween: cùng một ngày, trọn trong giờ", () => {
  const from = new Date("2026-08-10T03:00:00Z"); // 10:00
  const to = new Date("2026-08-10T04:00:00Z"); // 11:00
  assert.equal(operatingMsBetween(from, to, HOURS), 60 * MIN);
});

test("operatingMsBetween: cắt đúng hai mép khung", () => {
  // 08:00 → 18:00 giờ VN, khung 09:30–16:00 → chỉ tính 6,5 giờ.
  const from = new Date("2026-08-10T01:00:00Z");
  const to = new Date("2026-08-10T11:00:00Z");
  assert.equal(operatingMsBetween(from, to, HOURS), 390 * MIN);
});

test("operatingMsBetween: KHÔNG đếm ban đêm — ca đóng báo động giả mỗi tối", () => {
  // 17:37 T7 (segment cuối thật) → 09:35 T2 sáng. Đồng hồ thật ~40 giờ,
  // nhưng trong giờ vận hành mới có 5 phút.
  const from = new Date("2026-08-08T10:37:00Z");
  const to = new Date("2026-08-10T02:35:00Z");
  assert.equal(operatingMsBetween(from, to, HOURS), 5 * MIN);
});

test("operatingMsBetween: KHÔNG đếm Chủ nhật", () => {
  // Cả ngày Chủ nhật 09/08.
  const from = new Date("2026-08-08T17:00:00Z"); // 00:00 CN
  const to = new Date("2026-08-09T17:00:00Z"); // 00:00 T2
  assert.equal(operatingMsBetween(from, to, HOURS), 0);
});

test("operatingMsBetween: vẫn cộng dồn qua nhiều ngày — báo động thật không bị nuốt", () => {
  // Agent chết từ 09:30 T5 tới 09:30 T6 → trọn một ngày làm việc.
  const from = new Date("2026-08-06T02:30:00Z");
  const to = new Date("2026-08-07T02:30:00Z");
  assert.equal(operatingMsBetween(from, to, HOURS), 390 * MIN);
});

test("operatingMsBetween: 09:30→11:45 T2 = 135 phút, vượt ngưỡng crit 120", () => {
  const from = new Date("2026-08-08T10:37:00Z"); // 17:37 T7
  const to = new Date("2026-08-10T04:45:00Z"); // 11:45 T2
  assert.equal(operatingMsBetween(from, to, HOURS), 135 * MIN);
});

test("operatingMsBetween: mốc ngược/bằng nhau → 0, không ra số âm", () => {
  const a = new Date("2026-08-10T04:00:00Z");
  const b = new Date("2026-08-10T03:00:00Z");
  assert.equal(operatingMsBetween(a, b, HOURS), 0);
  assert.equal(operatingMsBetween(a, a, HOURS), 0);
});

test("operatingMsBetween: khoảng dài bất thường vẫn chặn ở trần 40 ngày, không treo", () => {
  const from = new Date("2020-01-01T00:00:00Z");
  const to = new Date("2026-08-10T04:00:00Z");
  const ms = operatingMsBetween(from, to, HOURS);
  // Trần 40 ngày × 6,5 giờ/ngày là cận trên tuyệt đối.
  assert.ok(ms > 0);
  assert.ok(ms <= 40 * 390 * MIN, `vượt trần: ${ms}`);
});

test("operatingMsBetween: vùng có DST vẫn ra đúng số giờ địa phương", () => {
  // 08/03/2026 là ngày Mỹ nhảy giờ (02:00 → 03:00 giờ New York). Khung
  // 09:30–16:00 giờ địa phương vẫn phải là 6,5 giờ, không phải 5,5 hay 7,5.
  const ny = parseOperatingHours({
    timezone: "America/New_York",
    start: "09:30",
    end: "16:00",
    days: [1, 2, 3, 4, 5, 6, 7],
  })!;
  const from = new Date("2026-03-08T00:00:00Z");
  const to = new Date("2026-03-09T00:00:00Z");
  assert.equal(operatingMsBetween(from, to, ny), 390 * MIN);
});

// ═══════════════════════════════════════════════════════════════════════
// Gộp nhiều kho + hiển thị
// ═══════════════════════════════════════════════════════════════════════

test("merge: một kho chưa khai giờ → cả org về 24/7 (thà theo dõi thừa)", () => {
  assert.equal(mergeOperatingHours([HOURS, null]), null);
  assert.equal(mergeOperatingHours([]), null);
});

test("merge: khác múi giờ → không gộp, về 24/7", () => {
  const other = parseOperatingHours({
    timezone: "Asia/Tokyo",
    start: "09:00",
    end: "17:00",
    days: [1],
  })!;
  assert.equal(mergeOperatingHours([HOURS, other]), null);
});

test("merge: cùng múi giờ → lấy khung bao ngoài", () => {
  const other = parseOperatingHours({
    timezone: "Asia/Bangkok",
    start: "08:00",
    end: "17:00",
    days: [7],
  })!;
  const merged = mergeOperatingHours([HOURS, other])!;
  assert.equal(merged.startMinute, 8 * 60);
  assert.equal(merged.endMinute, 17 * 60);
  assert.deepEqual(merged.days, [1, 2, 3, 4, 5, 6, 7]);
});

test("describe: đọc được trong tin Lark", () => {
  assert.equal(describeOperatingHours(HOURS), "T2–T7 09:30–16:00 (Asia/Bangkok)");
  const oddDays = parseOperatingHours({
    timezone: "Asia/Bangkok",
    start: "09:00",
    end: "12:00",
    days: [1, 3, 5],
  })!;
  assert.equal(describeOperatingHours(oddDays), "T2, T4, T6 09:00–12:00 (Asia/Bangkok)");
});
