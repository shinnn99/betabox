import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_HARD_LIMIT_SECONDS,
  ORDER_MIN_LIMIT_SECONDS,
  ORDER_WARNING_LEAD_SECONDS,
  computeOrderTimeout,
  resolveOrderLimitSeconds,
} from "../src/lib/station/order-timeout.ts";
import {
  buildAutoStopAnnouncement,
  buildPackingScanAnnouncement,
  buildStaffSessionAnnouncement,
} from "../src/lib/station/announcements.ts";

const T0 = new Date("2026-09-16T02:00:00.000Z");

test("kho chưa cấu hình thì dùng trần cứng 180s", () => {
  assert.equal(resolveOrderLimitSeconds(null), ORDER_HARD_LIMIT_SECONDS);
  assert.equal(resolveOrderLimitSeconds({}), ORDER_HARD_LIMIT_SECONDS);
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: "abc" }), ORDER_HARD_LIMIT_SECONDS);
});

test("max_order_seconds lớn hơn trần clip bị kéo về 180s", () => {
  // Đại Kim đang cấu hình 600s cho tầng nghiệp vụ; video vẫn chỉ 180s.
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: 600 }), 180);
});

test("cấu hình nhỏ hơn trần được tôn trọng, nhưng có sàn phòng thủ", () => {
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: 90 }), 90);
  // 3 = có người nhập phút thay vì giây → kéo lên sàn thay vì cắt clip 3s.
  assert.equal(resolveOrderLimitSeconds({ max_order_seconds: 3 }), ORDER_MIN_LIMIT_SECONDS);
});

test("đơn mới mở chưa hết giờ và chưa cảnh báo", () => {
  const state = computeOrderTimeout({
    startedAt: T0,
    limitSeconds: 180,
    now: new Date(T0.getTime() + 10_000),
  });
  assert.equal(state.expired, false);
  assert.equal(state.warning, false);
  assert.equal(state.remainingSeconds, 170);
  assert.equal(state.deadlineAt.toISOString(), "2026-09-16T02:03:00.000Z");
});

test("còn đúng ngưỡng lead thì bật cảnh báo sắp hết giờ", () => {
  const state = computeOrderTimeout({
    startedAt: T0,
    limitSeconds: 180,
    now: new Date(T0.getTime() + (180 - ORDER_WARNING_LEAD_SECONDS) * 1000),
  });
  assert.equal(state.warning, true);
  assert.equal(state.expired, false);
});

test("chạm đúng mốc 180s là hết hạn, phải cưỡng chế dừng", () => {
  const state = computeOrderTimeout({
    startedAt: T0,
    limitSeconds: 180,
    now: new Date(T0.getTime() + 180_000),
  });
  assert.equal(state.expired, true);
  assert.equal(state.warning, false);
  assert.equal(state.remainingSeconds, 0);
});

test("row hỏng thời gian bị coi là hết hạn để không treo vô hạn", () => {
  const state = computeOrderTimeout({
    startedAt: "không-phải-thời-gian",
    limitSeconds: 180,
    now: T0,
  });
  assert.equal(state.expired, true);
});

test("câu thông báo nghiệp vụ đã chốt không được đổi", () => {
  const openShift = buildStaffSessionAnnouncement({
    id: "s1",
    action: "checked_in",
    warningCode: null,
    message: null,
    createdAt: T0.toISOString(),
    staffLabel: "NV002 · Trần Văn B",
  });
  assert.equal(openShift.speech, "Mở ca thành công");
  assert.equal(openShift.level, "success");

  const scan = buildPackingScanAnnouncement({
    id: "p1",
    status: "valid",
    waybillCode: "SPXVN1",
    scannedAt: T0.toISOString(),
  });
  assert.equal(scan.speech, "Bắt đầu quay video");
  assert.equal(scan.message, "Bắt đầu quay video · SPXVN1");

  const autoStop = buildAutoStopAnnouncement({
    id: "p1",
    waybillCode: "SPXVN1",
    workEndedAt: T0.toISOString(),
    limitSeconds: 180,
  });
  assert.equal(autoStop.speech, "Video quá thời gian quy định, tự động dừng");
  assert.equal(autoStop.level, "error");
  // id phải khác id của chính lần quét để client đọc lại thông báo mới.
  assert.notEqual(autoStop.id, scan.id);
});

test("QR nhân viên lỗi thì báo lỗi, không báo mở ca", () => {
  const rejected = buildStaffSessionAnnouncement({
    id: "s2",
    action: "checked_in",
    warningCode: "already_checked_in",
    message: "Nhân viên đã mở ca ở bàn khác",
    createdAt: T0.toISOString(),
    staffLabel: "NV002 · Trần Văn B",
  });
  assert.equal(rejected.level, "error");
  assert.equal(rejected.message, "Nhân viên đã mở ca ở bàn khác");
  assert.equal(rejected.speech, "Mã nhân viên không hợp lệ");
});
