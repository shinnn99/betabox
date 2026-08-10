import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActivitySection } from "../src/lib/warehouse/live/overview.ts";
import { parseIssuesLimit } from "../src/lib/warehouse/live/issues.ts";
import {
  parseActivityLimit,
  type ActivityPayload,
} from "../src/lib/warehouse/live/activity.ts";

/**
 * Hợp đồng của /api/warehouse/live/overview — endpoint gộp bốn nhịp poll
 * của màn hình giám sát thành một.
 *
 * Chạy: pnpm test
 *
 * Điều dễ mất nhất khi gộp endpoint là RANH GIỚI LỖI. Bốn endpoint rời có
 * hai tầng: nhật ký hỏng chỉ hiện dòng lỗi nhỏ dưới bảng, còn KPI và thẻ
 * bàn đóng hàng vẫn vẽ bình thường. Gộp ẩu là biến một lỗi nhật ký thành
 * màn hình trắng — đúng lúc người ở kho cần nhìn nhất.
 */

const FAKE_ACTIVITY: ActivityPayload = {
  activity: [],
  date: "2026-08-08",
  invalid_date: false,
  limit: 100,
  total: 0,
};

test("không xin nhật ký (ngày quá khứ) → cả hai field null, không gọi builder", async () => {
  let called = 0;
  const section = await resolveActivitySection(false, async () => {
    called += 1;
    return FAKE_ACTIVITY;
  });

  assert.equal(called, 0, "include_activity=0 mà vẫn query là đốt CPU vô ích");
  assert.equal(section.activity, null);
  assert.equal(section.activity_error, null);
});

test("xin và lấy được → activity có, không báo lỗi", async () => {
  const section = await resolveActivitySection(true, async () => FAKE_ACTIVITY);
  assert.deepEqual(section.activity, FAKE_ACTIVITY);
  assert.equal(section.activity_error, null);
});

test("nhật ký hỏng KHÔNG ném ra ngoài — hạ xuống activity_error", async () => {
  const section = await resolveActivitySection(true, async () => {
    throw new Error("bảng raw events quá tải");
  });

  assert.equal(section.activity, null);
  assert.equal(
    section.activity_error,
    "bảng raw events quá tải",
    "lỗi nhật ký phải xuống field riêng, không được thổi bay cả overview",
  );
});

test("lỗi không có message vẫn ra chuỗi có nghĩa, không phải rỗng", async () => {
  const section = await resolveActivitySection(true, async () => {
    throw new Error("");
  });
  assert.equal(section.activity_error, "activity_failed");
});

test("phân biệt được 'không xin' với 'xin nhưng hỏng'", async () => {
  const skipped = await resolveActivitySection(false, async () => FAKE_ACTIVITY);
  const failed = await resolveActivitySection(true, async () => {
    throw new Error("hỏng");
  });

  // Cả hai đều activity=null; chỉ activity_error tách được hai ca. Client
  // dựa vào đúng chỗ này để quyết có hiện dòng lỗi dưới bảng hay không.
  assert.equal(skipped.activity, null);
  assert.equal(failed.activity, null);
  assert.equal(skipped.activity_error, null);
  assert.notEqual(failed.activity_error, null);
});

test("limit của overview kẹp đúng như bốn endpoint cũ", () => {
  // Mặc định khi client không gửi.
  assert.equal(parseIssuesLimit(null), 30);
  assert.equal(parseActivityLimit(null), 50);

  // Giá trị hợp lệ đi qua nguyên vẹn.
  assert.equal(parseIssuesLimit("10"), 10);
  assert.equal(parseActivityLimit("100"), 100);

  // Trần chặn — client không kéo được cả bảng về bằng một tham số.
  assert.equal(parseIssuesLimit("999"), 100);
  assert.equal(parseActivityLimit("99999"), 500);

  // Rác rơi về mặc định, không throw và không thành NaN.
  for (const junk of ["", "abc", "0", "-5"]) {
    assert.equal(parseIssuesLimit(junk), 30, `issues limit rác: ${junk}`);
    assert.equal(parseActivityLimit(junk), 50, `activity limit rác: ${junk}`);
  }

  // parseInt(_, 10) cắt ở ký tự lạ: "1e999" thành 1, "12abc" thành 12.
  // Không phải mặc định, nhưng vẫn là số dương nhỏ nên vô hại — ghi ra đây
  // để lần sau ai đọc không tưởng là bug rồi "sửa" thành NaN.
  assert.equal(parseIssuesLimit("1e999"), 1);
  assert.equal(parseActivityLimit("12abc"), 12);
});
