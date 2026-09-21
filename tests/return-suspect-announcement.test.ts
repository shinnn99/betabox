import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPackingScanAnnouncement } from "../src/lib/station/announcements.ts";

const AT = "2026-09-21T02:00:00.000Z";

/**
 * Lưới an toàn: mã đã đóng gửi đi ở một ngày trước, nay quét lại ở bàn đóng
 * hàng. Kiện giao thất bại quay về mang đúng mã cũ, nên đây gần như chắc
 * chắn là hàng hoàn.
 *
 * Nhân viên phải NGHE ĐƯỢC chuyện này ngay tại bàn: nếu chỉ im lặng không
 * tính đơn, họ tưởng máy không nhận mã và quét lại nhiều lần.
 */
test("mã đã đóng trước đó được loa báo là hàng hoàn, không phải lỗi", () => {
  const a = buildPackingScanAnnouncement({
    id: "p-return",
    status: "return_suspect",
    waybillCode: "SPXVN9",
    scannedAt: AT,
  });

  assert.equal(a.level, "warning");
  assert.match(a.message, /Hàng hoàn/);
  assert.match(a.message, /SPXVN9/);
  assert.match(a.speech, /hàng hoàn/i);
  assert.match(a.speech, /không tính đơn/i);
});

test("trạng thái lạ vẫn rơi về câu báo lỗi chung", () => {
  const a = buildPackingScanAnnouncement({
    id: "p-x",
    status: "trang_thai_moi_chua_biet",
    waybillCode: "SPXVN9",
    scannedAt: AT,
  });
  assert.equal(a.level, "error");
  assert.match(a.message, /Không xử lý được mã quét/);
});

test("đơn đi hợp lệ không bị đổi câu", () => {
  const a = buildPackingScanAnnouncement({
    id: "p-ok",
    status: "valid",
    waybillCode: "SPXVN1",
    scannedAt: AT,
  });
  assert.equal(a.level, "success");
  assert.equal(a.speech, "Bắt đầu quay video");
});
