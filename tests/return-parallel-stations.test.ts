import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moduleHolder } from "../src/lib/station/return-capture.ts";

/**
 * Đợt 6 hàng hoàn: mọi bàn nhận hoàn song song, lai với đóng hàng, MỘT máy
 * kho điều khiển mọi bàn (chủ dự án chốt 21/09/2026).
 */

const USER = "11111111-1111-4111-8111-111111111111";

test("người giữ phiên tính theo TAB, phần tài khoản luôn do server quyết", () => {
  assert.equal(moduleHolder(USER, "tab-abcdef12"), `module:${USER}:tab-abcdef12`);
  // Hai tab của cùng một tài khoản là hai người giữ khác nhau — máy này
  // thoát không tắt phiên của máy kia.
  assert.notEqual(moduleHolder(USER, "aaaaaaaa-1"), moduleHolder(USER, "bbbbbbbb-2"));
  // Không có / sai định dạng tab → dạng cũ theo tài khoản (giao diện cũ vẫn chạy).
  assert.equal(moduleHolder(USER, undefined), `module:${USER}`);
  assert.equal(moduleHolder(USER, "ngan"), `module:${USER}`);
  // Không cho chèn dấu ':' để giả người giữ khác.
  assert.equal(moduleHolder(USER, "x:module:other"), `module:${USER}`);
});

test("khoá ở database theo TỪNG BÀN, không theo tổ chức", () => {
  const sql = readFileSync("supabase/migrations/20260921140000_return_parallel_stations.sql", "utf8");
  assert.ok(sql.includes(`'station_mode:' || p_station_id::text`), "khoá phải theo bàn");
  assert.ok(!sql.includes("organization_id::text"), "khoá theo tổ chức là biến các bàn thành xếp hàng");
  for (const fn of ["open_return_capture", "release_return_capture"]) {
    const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
    const lockAt = body.indexOf("PERFORM public.lock_station_mode(p_station_id)");
    const modeAt = body.indexOf("set_station_mode");
    assert.ok(lockAt > 0 && lockAt < modeAt, `${fn} phải khoá bàn TRƯỚC khi đổi chế độ`);
  }
});

test("API nhận nhiều bàn một lượt, mỗi bàn xử lý và báo lỗi riêng", () => {
  const source = readFileSync("src/app/api/returns/capture/route.ts", "utf8");
  assert.ok(source.includes("body.station_ids"), "phải nhận station_ids");
  assert.ok(source.includes("MAX_STATIONS"), "phải có trần số bàn");
  assert.ok(source.includes("Promise.all("), "các bàn xử lý song song");
  assert.ok(
    source.includes(`return { station_id: stationId, ok: false, error: message }`),
    "một bàn lỗi không được làm hỏng các bàn còn lại",
  );
  assert.ok(source.includes("moduleHolder(ctx.userId, body.tab_id)"), "người giữ theo tab, tài khoản từ phiên đăng nhập");
  assert.ok(source.includes(`.eq("organization_id", ctx.organizationId)`), "bàn phải thuộc tổ chức người gọi");
});

test("giao diện giữ nhiều bàn: một nhịp, một tín hiệu đóng cho mọi bàn", () => {
  const source = readFileSync("src/components/returns/ReturnCaptureProvider.tsx", "utf8");
  assert.ok(source.includes(`station_ids: held, action: "heartbeat", tab_id: tabId`), "nhịp gửi mọi bàn một lượt");
  assert.ok(source.includes(`station_ids: held, action: "close", tab_id: tabId`), "rời phân hệ nhả mọi bàn một lượt");
  assert.ok(!/sessionStorage.(get|set)Item/.test(source), "tab id không lưu sessionStorage — nhân bản tab sẽ trùng người giữ");

  const panel = readFileSync("src/components/returns/ReturnCapturePanel.tsx", "utf8");
  assert.ok(panel.includes("Bắt đầu tất cả bàn") && panel.includes("Kết thúc tất cả"));
  // `stop([s.id], !held)`: bàn do nguồn khác bật thì ÉP dừng — nếu không,
  // một tab đã chết giữ bàn ở chế độ hoàn vĩnh viễn (sự cố 24/09/2026).
  assert.ok(
    panel.includes("stop([s.id], !held)") && panel.includes("start([s.id])"),
    "mỗi bàn bật tắt độc lập, và bàn do nguồn khác bật vẫn ép dừng được",
  );
  assert.ok(panel.includes('{held ? "Kết thúc" : "Ép dừng"}'), "nút nói rõ đang ép dừng");
});
