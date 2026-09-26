import { test } from "node:test";
import assert from "node:assert/strict";
import { planTimingRepair } from "../scripts/lib/late-scan-repair.mjs";

/**
 * Script sửa dữ liệu đã ghi sai sáng 26/09/2026 (kho Đại Kim). Dựng lại ĐÚNG
 * trạng thái database sau khi 4 mã tới ngược thứ tự — số liệu lấy từ ảnh chủ
 * dự án gửi — rồi kiểm kế hoạch sửa ra đúng thời gian thật.
 */

type Ev = Parameters<typeof planTimingRepair>[0][number];
/** "09:44:36" giờ Việt Nam ngày 26/09 → ISO UTC đúng định dạng toISOString. */
const at = (hms: string) => new Date(`2026-09-26T${hms}+07:00`).toISOString();
const ev = (id: string, start: string, end: string | null, dur: number | null, status: string, closedBy: string | null = null): Ev => ({
  id,
  scanned_at: at(start),
  work_started_at: at(start),
  work_ended_at: end ? at(end) : null,
  work_duration_seconds: dur,
  timing_status: status,
  closed_by_packing_event_id: closedBy,
});

// Trạng thái DB thật sau sự cố (ảnh 09:35–09:51).
const stateAfterIncident: Ev[] = [
  ev("862420788926", "09:44:06", "09:45:45", 99, "finalized_by_next_scan", "TTVN"),
  ev("862406638916", "09:44:36", "09:47:36", 180, "capped_timeout"),
  ev("862400898926", "09:45:20", "09:44:36", -44, "finalized_by_next_scan", "862406638916"),
  ev("TTVN1114532510", "09:45:45", "09:45:20", -25, "finalized_by_next_scan", "862400898926"),
];

test("sửa đúng chuỗi sự cố: 30s, 44s, 25s — không còn số âm, không còn chồng", () => {
  const fixes = planTimingRepair(stateAfterIncident, 180);
  const got = Object.fromEntries(fixes.map((f) => [f.id, [f.after.work_ended_at, f.after.work_duration_seconds, f.after.timing_status]]));
  assert.deepEqual(got["862420788926"], [at("09:44:36"), 30, "finalized_by_next_scan"]);
  assert.deepEqual(got["862406638916"], [at("09:45:20"), 44, "finalized_by_next_scan"]);
  assert.deepEqual(got["862400898926"], [at("09:45:45"), 25, "finalized_by_next_scan"]);
  // Đơn cuối âm, không có đơn kế: như tự dừng — bắt đầu + trần.
  assert.deepEqual(got["TTVN1114532510"], [at("09:48:45"), 180, "capped_timeout"]);
  assert.ok(fixes.every((f) => f.after.timing_note === "repaired_late_scan"));
});

test("đơn tự dừng ĐÚNG (kết thúc trước đơn kế) không bị đụng", () => {
  const fixes = planTimingRepair(
    [
      ev("A", "08:50:01", "08:53:01", 180, "capped_timeout"),
      ev("B", "08:54:13", "08:57:13", 180, "capped_timeout"),
      ev("C", "08:57:51", null, null, "open"),
    ],
    180,
  );
  assert.deepEqual(fixes, []);
});

test("đơn bị tự dừng rồi mã quét trước đó mới tới → rút về đúng giờ quét kế", () => {
  const fixes = planTimingRepair(
    [
      ev("SPX065", "09:08:10", "09:11:10", 180, "capped_timeout"),
      ev("26092TAV", "09:10:37", "09:11:48", 71, "finalized_by_next_scan", "SPX069"),
      ev("SPX069", "09:11:48", null, null, "open"),
    ],
    180,
  );
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].id, "SPX065");
  assert.equal(fixes[0].after.work_ended_at, at("09:10:37"));
  assert.equal(fixes[0].after.work_duration_seconds, 147);
});

test("khoảng thật dài hơn trần → capped_timeout, thời lượng = trần, vẫn kết thúc ở đơn kế", () => {
  const fixes = planTimingRepair(
    [ev("X", "10:00:00", "10:20:00", 1200, "finalized_by_next_scan"), ev("Y", "10:05:00", null, null, "open")],
    180,
  );
  assert.deepEqual([fixes[0].after.work_ended_at, fixes[0].after.work_duration_seconds, fixes[0].after.timing_status], [at("10:05:00"), 180, "capped_timeout"]);
});

test("dữ liệu đã đúng → không sửa gì", () => {
  assert.deepEqual(
    planTimingRepair(
      [
        ev("H", "10:00:00", "10:01:00", 60, "finalized_by_next_scan", "I"),
        ev("I", "10:01:00", "10:02:30", 90, "finalized_by_next_scan", "J"),
        ev("J", "10:02:30", null, null, "open"),
      ],
      180,
    ),
    [],
  );
});
