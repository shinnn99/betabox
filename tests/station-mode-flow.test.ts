import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStationModeAnnouncement } from "../src/lib/station/announcements.ts";

const AT = "2026-09-21T02:00:00.000Z";

test("chuyển sang nhận hoàn: loa nói rõ mã quét không tính đơn", () => {
  const a = buildStationModeAnnouncement({
    periodId: "p1",
    mode: "return",
    startedAt: AT,
    startedBy: "card",
  });
  assert.equal(a.id, "mode:p1");
  assert.equal(a.level, "warning");
  assert.match(a.message, /NHẬN HÀNG HOÀN/);
  assert.match(a.message, /không tính vào số đơn/);
  assert.match(a.speech, /nhận hàng hoàn/i);
});

test("hệ thống tự đưa về đóng hàng thì loa nói là tự về", () => {
  const a = buildStationModeAnnouncement({
    periodId: "p2",
    mode: "outbound",
    startedAt: AT,
    startedBy: "system",
  });
  assert.equal(a.level, "success");
  assert.match(a.speech, /tự về chế độ đóng hàng/i);
});

test("nhân viên quét thẻ đóng hàng thì không nói 'tự về'", () => {
  const a = buildStationModeAnnouncement({
    periodId: "p3",
    mode: "outbound",
    startedAt: AT,
    startedBy: "card",
  });
  assert.doesNotMatch(a.speech, /tự về/i);
});

/**
 * Thứ tự phân loại một lượt quét là thứ tự an toàn: thẻ điều khiển trước,
 * rồi QR nhân viên, cuối cùng mới là mã vận đơn. Đảo thứ tự thì một thẻ có
 * thể bị ghi thành đơn hàng.
 */
test("route quét phân loại thẻ điều khiển trước QR nhân viên", () => {
  const source = readFileSync("src/app/api/warehouse/scans/route.ts", "utf8");
  const fn = source.slice(
    source.indexOf("function detectScanType"),
    source.indexOf("function detectScanType") + 400,
  );
  const controlAt = fn.indexOf("looksLikeControlCard");
  const staffAt = fn.indexOf("tryParseStaffQr");
  assert.ok(controlAt > -1, "route phải nhận diện thẻ điều khiển");
  assert.ok(staffAt > -1, "route phải nhận diện QR nhân viên");
  assert.ok(controlAt < staffAt, "thẻ điều khiển phải được kiểm TRƯỚC QR nhân viên");
});

/**
 * Bàn kẹt ở chế độ nhận hoàn = đơn đi của nhân viên không được đếm. Phải có
 * HAI nhịp độc lập đưa bàn về: màn hình bàn (khi có người mở) và heartbeat
 * của agent (khi không ai mở màn hình).
 */
test("có hai nhịp độc lập đưa bàn về chế độ đóng hàng", () => {
  for (const file of [
    "src/app/api/live/[stationId]/events/route.ts",
    "src/app/api/warehouse/heartbeat/route.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes("revertIdleReturnModes"),
      `${file} phải gọi revertIdleReturnModes`,
    );
  }
});

test("mọi lượt quét ở bàn đều gia hạn mốc không thao tác", () => {
  const source = readFileSync("src/app/api/warehouse/scans/route.ts", "utf8");
  assert.ok(
    source.includes("touch_station_mode_activity"),
    "route quét phải gia hạn mốc, nếu không bàn tự về giữa lúc đang làm",
  );
});

test("migration giữ đủ ba lối ra của chế độ nhận hoàn", () => {
  const sql = readFileSync("supabase/migrations/20260921100000_station_modes.sql", "utf8");
  assert.ok(sql.includes("revert_idle_return_modes"), "thiếu lối ra: 5 phút không thao tác");
  assert.ok(
    sql.includes("staff_work_sessions_revert_station_mode"),
    "thiếu lối ra: đóng ca",
  );
  assert.ok(
    sql.includes("packing_stations_apply_purpose"),
    "thiếu đường: đổi chế độ mặc định trên giao diện",
  );
  assert.ok(
    sql.includes("station_mode_periods_one_open_idx"),
    "thiếu bất biến: mỗi bàn tối đa một kỳ đang mở",
  );
});
