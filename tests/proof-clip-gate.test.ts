import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProofClipGate } from "../src/lib/order-proof/proof-clip-gate.ts";

/**
 * Cổng chặn cắt proof clip khi đơn chưa đóng.
 *
 * Ca gốc (đã cắn thật, kho Đại Kim): mở /watch lúc đơn còn 'open' →
 * resolver không có work_ended_at → rơi nhánh default_post 60s → clip
 * 70s được lưu làm bằng chứng cho đơn thực tế 180s.
 *
 * Verify HAI NỬA:
 *   - nửa dương-đúng: 'open' → BỊ chặn.
 *   - nửa âm-đúng: mọi trạng thái đã đóng → KHÔNG bị chặn (không được
 *     làm mất khả năng xem clip của đơn hợp lệ).
 */

test("ca 70s/open: đơn còn 'open' → chặn cắt clip", () => {
  const gate = evaluateProofClipGate("open");
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "order_still_open");
  assert.match(gate.message ?? "", /đang được đóng gói/);
});

test("mọi timing_status đã đóng đều được cắt", () => {
  for (const status of [
    "finalized_by_next_scan",
    "finalized_by_checkout",
    "capped_timeout",
    "default_estimated",
    "not_applicable",
  ]) {
    assert.equal(
      evaluateProofClipGate(status).allowed,
      true,
      `${status} phải được phép cắt`,
    );
  }
});

test("null/undefined (row cũ trước khi có cột timing) → vẫn cho cắt", () => {
  assert.equal(evaluateProofClipGate(null).allowed, true);
  assert.equal(evaluateProofClipGate(undefined).allowed, true);
});

test("chuỗi lạ không phải 'open' → cho cắt, không chặn nhầm", () => {
  assert.equal(evaluateProofClipGate("OPEN").allowed, true);
  assert.equal(evaluateProofClipGate("opened").allowed, true);
  assert.equal(evaluateProofClipGate("").allowed, true);
});
