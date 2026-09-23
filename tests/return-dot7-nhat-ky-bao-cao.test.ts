import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyReturnEvent } from "../src/lib/warehouse/live/returns.ts";
import { aggregateReturns } from "../src/lib/reports/service.ts";
import { evaluateProofClipGate } from "../src/lib/order-proof/proof-clip-gate.ts";

/**
 * Hàng hoàn đợt 7 (chủ dự án chốt 23/09/2026) — xem
 * plans/active/HOAN-HANG-dot-7-nhat-ky-bao-cao-han-luu.md
 */

// ---------------------------------------------------------------------------
// 1. Nhật ký hàng hoàn nói cùng thứ tiếng với đóng hàng
// ---------------------------------------------------------------------------

const base = { timing_status: null, return_kind: null, inspection_result: null, close_reason: null };

test("kiện hoàn dùng ĐÚNG loại của đóng hàng; ghi chú luôn rỗng", () => {
  // Hoàn là hoàn: cột Loại nói đủ, cột Ghi chú chỉ dành cho cảnh báo video
  // nặng (ProofSizeBadge) — đúng như trang Giám sát đóng hàng.
  const cases: Array<[string, string, string]> = [
    ["valid", "waybill_valid", "ok"],
    ["duplicated_return", "waybill_duplicated", "warning"],
    ["return_suspect", "waybill_return_suspect", "warning"],
    ["no_active_session", "waybill_no_session", "error"],
  ];
  for (const [status, kind, category] of cases) {
    assert.deepEqual(classifyReturnEvent({ ...base, status, return_kind: "rts" }), {
      kind,
      category,
      note: null,
    });
  }
});

test("kiện đang mở / kết quả kiểm KHÔNG đẻ ra loại hay ghi chú riêng", () => {
  const open = classifyReturnEvent({ ...base, status: "valid", timing_status: "open", return_kind: "rts" });
  const swapped = classifyReturnEvent({
    ...base,
    status: "valid",
    return_kind: "customer_return",
    inspection_result: "swapped",
    close_reason: "next_scan",
  });
  assert.equal(open.kind, "waybill_valid");
  assert.equal(swapped.kind, "waybill_valid");
  assert.equal(open.note, null, "không nhồi 'đang mở kiện' vào ghi chú");
  assert.equal(swapped.note, null, "lý do hoàn và kết quả kiểm không vào nhật ký");
});

test("hai trang giám sát dùng CHUNG bộ nhãn của đóng hàng", () => {
  const ops = readFileSync("src/app/dashboard/operations/page.tsx", "utf8");
  const ret = readFileSync("src/app/dashboard/(return-module)/returns/page.tsx", "utf8");
  for (const src of [ops, ret]) {
    assert.ok(src.includes('waybill_no_session: "Chưa vào ca"'), "cùng chữ với đóng hàng");
    assert.ok(src.includes('waybill_invalid: "Mã sai"'));
    assert.ok(src.includes('waybill_valid: "Hợp lệ"'));
    assert.ok(src.includes('waybill_duplicated: "Trùng"'));
  }
  for (const gone of ['return_open: "', 'return_ok: "', 'return_problem: "', 'return_duplicated: "', 'return_suspect: "Lưới an toàn"']) {
    assert.ok(!ret.includes(gone), `bỏ nhãn tự chế: ${gone}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Chưa mở ca: không quay, không giờ, không clip
// ---------------------------------------------------------------------------

test("chưa mở ca thì không cắt clip", () => {
  const denied = evaluateProofClipGate("not_applicable", "no_active_session");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "no_active_session");
  assert.ok(denied.message?.includes("chưa mở ca"));
  // Đơn thường vẫn cắt được như cũ.
  assert.equal(evaluateProofClipGate("finalized_by_next_scan", "valid").allowed, true);
  assert.equal(evaluateProofClipGate("open", "valid").allowed, false, "đơn chưa đóng vẫn chặn như cũ");
});

test("migration: kiểm ca TRƯỚC lưới an toàn nên không có ca thì không ghi giờ", () => {
  const sql = readFileSync("supabase/migrations/20260923090000_no_session_no_video.sql", "utf8").replace(/\r\n/g, "\n");
  const i = sql.indexOf("if v_session_id is null then");
  const j = sql.indexOf("v_status := 'return_suspect'");
  assert.ok(i > 0 && j > 0, "phải có cả hai nhánh");
  assert.ok(i < j, "nhánh không-có-ca phải đứng TRƯỚC nhánh lưới an toàn");
  // Giờ bắt đầu/kết thúc chỉ ghi cho kiện suspect thật (có ca) hoặc đơn mở.
  assert.ok(sql.includes("when v_status = 'return_suspect' then v_raw.scanned_at"));
});

// ---------------------------------------------------------------------------
// 3. Báo cáo hiệu suất có phần hàng hoàn, tính riêng
// ---------------------------------------------------------------------------

test("báo cáo đếm số kiện hoàn, bỏ lượt chưa mở ca", () => {
  const rows = [
    { business_date: "2026-09-22", status: "valid", return_kind: "rts", inspection_result: "ok" },
    { business_date: "2026-09-22", status: "valid", return_kind: "customer_return", inspection_result: "swapped" },
    { business_date: "2026-09-23", status: "return_suspect", return_kind: "suspect", inspection_result: "unchecked" },
    { business_date: "2026-09-23", status: "duplicated_return", return_kind: "rts", inspection_result: null },
    { business_date: "2026-09-23", status: "no_active_session", return_kind: null, inspection_result: null },
  ];
  const out = aggregateReturns(rows, "2026-09-22", "2026-09-23");
  // Hoàn là hoàn: chỉ đếm số kiện, không tách theo lý do hoàn.
  assert.deepEqual(out.totals, { total: 3, duplicated: 1 });
  assert.deepEqual(
    out.daily.map((d) => [d.date, d.total]),
    [
      ["2026-09-22", 2],
      ["2026-09-23", 1],
    ],
  );
});

test("số kiện hoàn KHÔNG trộn vào sản lượng đóng hàng", () => {
  const svc = readFileSync("src/lib/reports/service.ts", "utf8");
  assert.ok(svc.includes('.eq("event_kind", "outbound")'), "sản lượng vẫn chỉ đếm đơn đi");
  assert.ok(svc.includes('.eq("event_kind", "return")'), "có truy vấn riêng cho kiện hoàn");
  const page = readFileSync("src/app/dashboard/reports/page.tsx", "utf8");
  assert.ok(page.includes("<ReturnsReportCard"), "trang báo cáo có khung Hàng hoàn");
});

// ---------------------------------------------------------------------------
// 4. Cấu hình kho: số ngày giữ video hàng hoàn
// ---------------------------------------------------------------------------

test("cấu hình kho có ô số ngày giữ video hàng hoàn, lưu qua API tổ chức", () => {
  const page = readFileSync("src/app/dashboard/settings/warehouse-config/page.tsx", "utf8");
  assert.ok(page.includes("Số ngày giữ video hàng hoàn"));
  assert.ok(page.includes("return_retention_days: value"));
  const api = readFileSync("src/app/api/organization/route.ts", "utf8");
  assert.ok(api.includes('"return_retention_days",'), "API cho sửa trường mới");
  assert.ok(api.includes("return_retention_days, created_at"), "API trả trường mới");
  const plan = readFileSync("src/app/api/agent/retention-plan/route.ts", "utf8");
  assert.ok(plan.includes('.select("return_retention_days")'), "agent đọc cấu hình cấp tổ chức");
  const sql = readFileSync("supabase/migrations/20260923100000_org_return_retention_days.sql", "utf8");
  assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS return_retention_days"));
  assert.ok(sql.includes(">= 7 AND return_retention_days <= 365"), "cùng dải với hạn chung");
});
