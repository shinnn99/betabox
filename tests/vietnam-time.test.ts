import { test } from "node:test";
import assert from "node:assert/strict";
import { vnHour, formatVnTime, formatVnDateTime } from "../src/lib/time/vietnam.ts";
import { buildMessageParts } from "../src/lib/lark/messages.ts";

/**
 * Giờ VN trên đường server (TZ=UTC như Vercel).
 *
 * Test này chỉ có nghĩa khi process chạy TZ=UTC — đó chính là môi trường làm
 * bug nổ. Chạy:
 *   TZ=UTC node --experimental-strip-types --test tests/vietnam-time.test.ts
 *
 * Instant mốc: 2026-08-06T03:25:38Z = 10:25:38 ngày 06/08/2026 giờ VN.
 * Đây là tin Lark thật đã gửi sai (card hiện "Lúc: 03:25:38").
 */

const ISO = "2026-08-06T03:25:38.000Z";

// NỬA "TRƯỚC FIX PHẢI FAIL": chốt rằng ở TZ=UTC, cách cũ (getHours) THẬT SỰ
// sai. Nếu vế này không đỏ thì test đang chạy sai TZ và mọi vế dưới là
// xanh-may-mắn, không phải xanh-do-fix.
test("sanity: ở TZ=UTC thì getHours() sai 7 tiếng (bug cũ tái hiện được)", () => {
  if (process.env.TZ !== "UTC") {
    // Không ép fail — chỉ nêu rõ test đang không kiểm được điều nó định kiểm.
    console.warn(`[skip] TZ=${process.env.TZ ?? "(không set)"} — chạy lại với TZ=UTC`);
    return;
  }
  assert.equal(new Date(ISO).getHours(), 3, "TZ process không phải UTC");
  assert.notEqual(new Date(ISO).getHours(), 10);
});

test("vnHour: 03:25Z → 10 giờ VN", () => {
  assert.equal(vnHour(ISO), 10);
});

test("vnHour: qua nửa đêm — 17:30Z → 00 giờ VN ngày hôm sau", () => {
  assert.equal(vnHour("2026-08-06T17:30:00.000Z"), 0);
  assert.equal(vnHour("2026-08-06T16:59:59.000Z"), 23);
});

test("formatVnTime: ra HH:mm:ss giờ VN", () => {
  assert.equal(formatVnTime(ISO), "10:25:38");
  assert.equal(formatVnTime("2026-08-06T00:00:00.000Z"), "07:00:00");
});

test("formatVnDateTime: đổi cả NGÀY khi vượt mốc 17:00Z", () => {
  assert.equal(formatVnDateTime("2026-08-06T17:30:00.000Z"), "07/08/2026 00:30:00");
});

test("input hỏng → trả nguyên chuỗi, không throw, không 'NaN:NaN'", () => {
  assert.equal(vnHour("khong-phai-ngay"), null);
  assert.equal(formatVnTime("khong-phai-ngay"), "khong-phai-ngay");
  assert.doesNotThrow(() => formatVnDateTime("rác"));
});

// Vế end-to-end: đúng cái card đã gửi sai lên Lark.
test("card Lark: hiện 10:25:38 (giờ kho), không phải 03:25:38 (UTC)", () => {
  const parts = buildMessageParts({
    eventType: "packing_issue_no_active_session",
    warehouseName: "Kho Đại Kim",
    waybillCode: "260806KKP4NYWJ",
    scannedAtIso: ISO,
    suppressedWaybillsInPreviousWindow: [],
    dashboardUrl: null,
  });
  assert.ok(
    parts.bodyLines.includes("**Lúc:** 10:25:38"),
    `bodyLines sai: ${JSON.stringify(parts.bodyLines)}`,
  );
  assert.ok(!parts.plainText.includes("03:25:38"));
});
