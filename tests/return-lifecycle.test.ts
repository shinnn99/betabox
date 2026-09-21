import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReturnScanAnnouncement } from "../src/lib/station/announcements.ts";
import {
  computeFinalizedClipWindow,
  MAX_CLIP_DURATION_SECONDS,
  MAX_RETURN_CLIP_DURATION_SECONDS,
} from "../src/lib/order-proof/clip-window.ts";
import {
  RETURN_HARD_LIMIT_SECONDS,
  resolveLimitSecondsFor,
  resolveReturnLimitSeconds,
} from "../src/lib/station/order-timeout.ts";

const AT = "2026-09-21T02:00:00.000Z";

// ---------------------------------------------------------------------------
// Câu loa: nhân viên phải biết mình đang quay kiện hoàn, không phải đơn đi.
// ---------------------------------------------------------------------------

test("kiện hoàn đang mở: loa nói rõ là kiện hoàn", () => {
  const a = buildReturnScanAnnouncement({
    id: "r1",
    status: "valid",
    waybillCode: "SPXVN9",
    scannedAt: AT,
    returnKind: "customer_return",
    inspectionResult: null,
    closeReason: null,
  });
  assert.equal(a.id, "return:r1");
  assert.match(a.message, /kiện hoàn/i);
  assert.match(a.speech, /kiện hoàn/i);
});

test("kiện hoàn của mã đã gửi đi: loa nhắc đã gửi đi trước đó", () => {
  const a = buildReturnScanAnnouncement({
    id: "r2",
    status: "valid",
    waybillCode: "SPXVN9",
    scannedAt: AT,
    returnKind: "rts",
    inspectionResult: null,
    closeReason: null,
  });
  assert.match(a.message, /đã gửi đi trước đó/);
});

test("kết quả khác OK: nói rõ đã mở hồ sơ", () => {
  for (const [result, label] of [
    ["damaged", "hỏng"],
    ["missing", "thiếu"],
    ["swapped", "tráo"],
    ["unchecked", "chưa kiểm"],
  ] as const) {
    const a = buildReturnScanAnnouncement({
      id: `r-${result}`,
      status: "valid",
      waybillCode: "SPXVN9",
      scannedAt: AT,
      returnKind: "rts",
      inspectionResult: result,
      closeReason: "result_card",
    });
    assert.match(a.message, new RegExp(label), result);
    assert.match(a.message, /hồ sơ/, result);
  }
});

test("kiện tự dừng quá giờ: loa nói là tự dừng", () => {
  const a = buildReturnScanAnnouncement({
    id: "r3",
    status: "valid",
    waybillCode: "SPXVN9",
    scannedAt: AT,
    returnKind: "rts",
    inspectionResult: "unchecked",
    closeReason: "timeout",
  });
  assert.match(a.speech, /tự dừng/);
});

test("quét lại kiện đã ghi hoàn: cảnh báo, không phải lỗi", () => {
  const a = buildReturnScanAnnouncement({
    id: "r4",
    status: "duplicated_return",
    waybillCode: "SPXVN9",
    scannedAt: AT,
    returnKind: "customer_return",
    inspectionResult: null,
    closeReason: null,
  });
  assert.equal(a.level, "warning");
  assert.match(a.message, /đã ghi hoàn/);
});

// ---------------------------------------------------------------------------
// Thời gian: kiện hoàn 5 phút, đơn đi giữ nguyên 180 giây.
// ---------------------------------------------------------------------------

test("trần kiện hoàn mặc định 5 phút, đơn đi không đổi", () => {
  assert.equal(RETURN_HARD_LIMIT_SECONDS, 300);
  assert.equal(resolveReturnLimitSeconds(null), 300);
  assert.equal(resolveReturnLimitSeconds({ return_max_seconds: 600 }), 600);
  // Cấu hình sai đơn vị không được làm kiện đóng ngay lập tức.
  assert.equal(resolveReturnLimitSeconds({ return_max_seconds: 3 }), 60);
  assert.equal(resolveLimitSecondsFor("return", { max_order_seconds: 600 }), 300);
  assert.equal(resolveLimitSecondsFor("outbound", { max_order_seconds: 600 }), 180);
});

test("clip kiện hoàn dài hơn clip đơn đi", () => {
  assert.ok(MAX_RETURN_CLIP_DURATION_SECONDS > MAX_CLIP_DURATION_SECONDS);

  const scannedAt = new Date("2026-09-21T02:00:00.000Z");
  const workEndedAt = "2026-09-21T02:04:30.000Z"; // 4 phút 30 giây
  const common = { scannedAt, workEndedAt, preSeconds: 5, defaultPostSeconds: 60 };

  const outbound = computeFinalizedClipWindow({ ...common, eventKind: "outbound" });
  assert.equal(outbound.endReason, "capped_at_max_duration");
  assert.equal(outbound.windowSeconds, MAX_CLIP_DURATION_SECONDS);

  const ret = computeFinalizedClipWindow({ ...common, eventKind: "return" });
  assert.equal(ret.endReason, "work_ended");
  assert.ok(ret.windowSeconds > MAX_CLIP_DURATION_SECONDS);
  assert.ok(ret.windowSeconds <= MAX_RETURN_CLIP_DURATION_SECONDS);
});

// ---------------------------------------------------------------------------
// Canh giữ các đường nối: mất một mắt xích là mất bằng chứng hoặc treo kiện.
// ---------------------------------------------------------------------------

test("vòng tự dừng xử lý riêng kiện hoàn qua RPC đóng kiện", () => {
  const source = readFileSync("src/lib/station/force-stop-expired-orders.ts", "utf8");
  assert.ok(source.includes("resolveReturnLimitSeconds"), "phải dùng trần riêng cho kiện hoàn");
  assert.ok(
    source.includes("close_return_event"),
    "kiện hoàn phải đóng qua RPC — đó là chỗ ghi kết quả và kích hoạt hồ sơ",
  );
  assert.ok(source.includes('p_close_reason: "timeout"'), "phải ghi lý do đóng là timeout");
});

test("mã vận đơn đi đúng nhánh theo chế độ bàn", () => {
  for (const file of [
    "src/app/api/warehouse/scans/route.ts",
    "src/app/api/warehouse/manual-scan/route.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("currentStationMode"), `${file} phải đọc chế độ bàn`);
    assert.ok(source.includes("processReturnScan"), `${file} phải có nhánh kiện hoàn`);
    assert.ok(
      source.includes("closeOpenReturnWithResult"),
      `${file} phải xử lý thẻ kết quả`,
    );
  }
});

test("hồ sơ hết hạn và clip kiện hoàn được xử lý ở nhịp heartbeat", () => {
  const source = readFileSync("src/app/api/warehouse/heartbeat/route.ts", "utf8");
  assert.ok(source.includes("expire_return_claims"), "thiếu lối ra tự động của hồ sơ");
  assert.ok(
    source.includes("requestClipsForOpenReturnClaims"),
    "kiện có vấn đề phải được cắt clip ngay, không chờ người mở",
  );
});

test("migration giữ đủ các đường đóng kiện hoàn", () => {
  const sql = readFileSync("supabase/migrations/20260921110000_return_lifecycle.sql", "utf8");
  for (const reason of [
    "result_card",
    "end_card",
    "next_scan",
    "mode_switch",
    "shift_closed",
    "timeout",
  ]) {
    assert.ok(sql.includes(reason), `thiếu lý do đóng: ${reason}`);
  }
  assert.ok(
    sql.includes("packing_events_open_return_claim"),
    "thiếu trigger mở hồ sơ cho mọi đường đóng kiện",
  );
  assert.ok(
    sql.includes("and pe.event_kind = 'outbound'"),
    "checkout chỉ được chốt đơn đi, không chốt nhầm kiện hoàn",
  );
});
