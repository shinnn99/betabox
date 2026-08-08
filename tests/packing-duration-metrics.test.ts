import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMeasuredDuration,
  PACKING_EVENT_TIMING_STATUSES,
  PACKING_EVENT_MEASURED_TIMING_STATUSES,
} from "../src/lib/domain-status.ts";

/**
 * Quy tắc: KPI thời gian đóng gói chỉ tính trên duration ĐO ĐƯỢC.
 *
 * capped_timeout ghi duration = max_order_seconds và default_estimated
 * ghi duration = default_last_order_seconds — số ép theo cấu hình, không
 * phải thời gian thật. Đo ở kho Đại Kim 2026-08-07: trung bình gộp
 * 95,3s vs đo được 68,2s, gap thật 260,2s.
 */

test("chỉ finalized_by_next_scan và finalized_by_checkout là đo được", () => {
  assert.equal(isMeasuredDuration("finalized_by_next_scan"), true);
  assert.equal(isMeasuredDuration("finalized_by_checkout"), true);
});

test("số ép cứng KHÔNG được tính vào KPI", () => {
  assert.equal(isMeasuredDuration("capped_timeout"), false);
  assert.equal(isMeasuredDuration("default_estimated"), false);
});

test("trạng thái không có duration cũng bị loại", () => {
  assert.equal(isMeasuredDuration("open"), false);
  assert.equal(isMeasuredDuration("not_applicable"), false);
  assert.equal(isMeasuredDuration(null), false);
  assert.equal(isMeasuredDuration(undefined), false);
});

test("mọi timing_status trong domain đều được phân loại rõ ràng", () => {
  // Thêm timing_status mới vào CHECK constraint mà quên xếp loại ở đây
  // thì nó lặng lẽ rơi vào "không đo được" — test này bắt lúc đó.
  for (const status of PACKING_EVENT_TIMING_STATUSES) {
    const measured = isMeasuredDuration(status);
    assert.equal(
      measured,
      PACKING_EVENT_MEASURED_TIMING_STATUSES.includes(status),
      `${status}: isMeasuredDuration lệch với danh sách MEASURED`,
    );
  }
});
