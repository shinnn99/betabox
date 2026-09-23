import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyReturnEvent } from "../src/lib/warehouse/live/returns.ts";
import { aggregateReturns } from "../src/lib/reports/service.ts";
import { evaluateProofClipGate } from "../src/lib/order-proof/proof-clip-gate.ts";
import { describeScanIssue, ISSUE_STATUSES } from "../src/lib/warehouse/live/issues.ts";

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

test("báo cáo hoàn hàng viết y nguyên thuộc tính của đóng hàng", () => {
  const row = (id: string, business_date: string, status: string, staff_id: string | null, dur: number | null) => ({
    id,
    business_date,
    status,
    timing_status: dur === null ? null : "finalized_by_next_scan",
    work_duration_seconds: dur,
    order_id: null,
    staff_id,
    manual_error: false,
  });
  const rows = [
    row("a", "2026-09-22", "valid", "nv1", 60),
    row("b", "2026-09-22", "valid", "nv1", 120),
    // Lưới an toàn LÀ kiện hoàn thật — tính như kiện hợp lệ.
    row("c", "2026-09-23", "return_suspect", "nv2", null),
    // Quét lại: không phải kiện mới.
    row("d", "2026-09-23", "duplicated_return", "nv1", null),
    // Lượt quét hỏng: không phải kiện nào cả.
    row("e", "2026-09-23", "no_active_session", null, null),
  ];
  const profiles = new Map([
    ["nv1", { full_name: "Nguyễn Văn A", email: null }],
    ["nv2", { full_name: "Trần Thị B", email: null }],
  ]);
  const out = aggregateReturns(rows, "2026-09-22", "2026-09-23", new Set(["a"]), profiles, 2);

  assert.equal(out.totals.total_scans, 4, "3 kiện + 1 lượt quét lại, bỏ lượt chưa vào ca");
  assert.equal(out.totals.valid, 3);
  assert.equal(out.totals.duplicated, 1);
  assert.equal(out.totals.avg_duration_seconds, 90, "thời gian trung bình như bên đóng hàng");
  assert.deepEqual(
    out.daily.map((d) => [d.business_date, d.total]),
    [
      ["2026-09-22", 2],
      ["2026-09-23", 2],
    ],
  );

  // Bảng theo nhân sự: ĐỦ các cột của đóng hàng, không thiếu thuộc tính nào.
  const nv1 = out.staff.find((s) => s.staff_id === "nv1");
  assert.ok(nv1);
  assert.deepEqual(Object.keys(nv1).sort(), [
    "active_days",
    "avg_duration_seconds",
    "avg_videos_per_day",
    "duplicated_orders",
    "email",
    "full_name",
    "manual_error_orders",
    "staff_id",
    "valid_orders",
    "video_count",
  ]);
  assert.equal(nv1.valid_orders, 2);
  assert.equal(nv1.duplicated_orders, 1);
  assert.equal(nv1.video_count, 1);
  assert.equal(out.staff.find((s) => s.staff_id === "nv2")?.valid_orders, 1);
});

test("số kiện hoàn KHÔNG trộn vào sản lượng đóng hàng", () => {
  const svc = readFileSync("src/lib/reports/service.ts", "utf8");
  assert.ok(svc.includes('.eq("event_kind", "outbound")'), "sản lượng vẫn chỉ đếm đơn đi");
  assert.ok(svc.includes('.eq("event_kind", "return")'), "có truy vấn riêng cho kiện hoàn");
  const page = readFileSync("src/app/dashboard/reports/page.tsx", "utf8");
  assert.ok(page.includes("Sản lượng hoàn hàng theo ngày"), "có biểu đồ riêng cho đơn hoàn");
  assert.ok(page.includes('title="Báo cáo đóng hàng theo nhân sự"'));
  assert.ok(page.includes('title="Báo cáo hoàn hàng theo nhân sự"'));
  assert.ok(page.includes("Tổng đơn hoàn"), "thẻ số có tổng đơn hoàn");
  assert.ok(page.includes("Thời gian đóng hàng TB"), "đổi tên thời gian xử lý");
  assert.ok(!page.includes("ReturnsReportCard"), "bỏ khung Hàng hoàn cũ");
  // MỘT khung bảng cho cả hai luồng thì không bao giờ lệch cột.
  assert.equal(page.split("function StaffReportTable(").length - 1, 1);
  assert.equal(page.split("<StaffReportTable").length - 1, 2);
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

// ---------------------------------------------------------------------------
// 5. Cột mã vận đơn của Bằng chứng hoàn hàng: chỉ còn hạn khiếu nại
// ---------------------------------------------------------------------------

test("bằng chứng hoàn hàng bỏ lý do hoàn và kết quả kiểm, chỉ giữ đếm ngược", () => {
  const page = readFileSync("src/app/dashboard/(return-module)/return-videos/page.tsx", "utf8");
  for (const gone of ["RETURN_KIND_LABEL", "INSPECTION_LABEL", "Khách trả", "Chưa kiểm", "Loại hoàn"]) {
    assert.ok(!page.includes(gone), `cột mã vận đơn không còn ghi chú: ${gone}`);
  }
  // Hạn khiếu nại đếm ngược vẫn còn — đây là thứ duy nhất cần nhìn.
  assert.ok(page.includes("function remainingLabel("), "giữ hàm đếm ngược");
  assert.ok(page.includes("remainingLabel(scan.claim.deadline_at)"), "vẫn hiện thời gian còn lại");
});

// ---------------------------------------------------------------------------
// 6. "Cần xử lý" của hoàn hàng làm y như đóng hàng — nguồn riêng, xử lý chung
// ---------------------------------------------------------------------------

test("hai luồng cùng một bộ chữ cho việc cần xử lý", () => {
  const cases: Array<[string, string, string]> = [
    ["duplicated", "duplicated", "Đơn quét trùng"],
    ["duplicated_return", "duplicated", "Đơn quét trùng"],
    ["no_active_session", "no_active_session", "Quét khi chưa vào ca"],
    ["unmapped_scanner", "unmapped_scanner", "Máy quét chưa gán bàn"],
    ["invalid_code", "invalid_code", "Mã không hợp lệ"],
  ];
  for (const [status, kind, title] of cases) {
    const out = describeScanIssue({
      status,
      waybill_code: "LEX1",
      scanner_device_code: "SC-1",
      station_name: "Bàn 3",
    });
    assert.equal(out.kind, kind);
    assert.equal(out.title, title, `trạng thái ${status} phải dùng chữ của đóng hàng`);
  }
  // Lưới an toàn chỉ có ở luồng hoàn, và đọc đúng chữ của nhật ký.
  assert.equal(describeScanIssue({ status: "return_suspect", waybill_code: "LEX2", scanner_device_code: null, station_name: "Bàn 1" }).title, "Hàng hoàn");
});

test("nguồn riêng: mỗi màn hình chỉ đọc lượt quét của luồng mình", () => {
  const outbound = readFileSync("src/lib/warehouse/live/issues.ts", "utf8");
  const ret = readFileSync("src/lib/warehouse/live/returns.ts", "utf8");
  assert.ok(outbound.includes('.eq("event_kind", "outbound")'), "đóng hàng chỉ đọc đơn đi");
  assert.ok(ret.includes('.eq("event_kind", "return")'), "hoàn hàng chỉ đọc kiện hoàn");
  assert.deepEqual([...ISSUE_STATUSES.outbound], [
    "duplicated",
    "no_active_session",
    "unmapped_scanner",
    "invalid_code",
  ]);
  assert.ok(ISSUE_STATUSES.return.includes("return_suspect"), "luồng hoàn có thêm lưới an toàn");
});

test("Cần xử lý của hoàn hàng không còn là danh sách hồ sơ khiếu nại", () => {
  const ret = readFileSync("src/lib/warehouse/live/returns.ts", "utf8");
  assert.ok(!ret.includes("return_claims"), "khối việc cần làm không đọc hồ sơ khiếu nại nữa");
  assert.ok(!ret.includes("claim_open"));
  const summary = readFileSync("src/lib/warehouse/live/summary.ts", "utf8");
  assert.ok(!summary.includes("open_claims"), "thẻ số bỏ luôn phép đếm hồ sơ mỗi nhịp poll");
  // Đồng hồ đếm ngược vẫn còn — ở đúng chỗ của nó.
  const proof = readFileSync("src/app/dashboard/(return-module)/return-videos/page.tsx", "utf8");
  assert.ok(proof.includes("remainingLabel(scan.claim.deadline_at)"));
});

// ---------------------------------------------------------------------------
// 7. "Hoạt động hôm nay" của hai màn hình giống hệt nhau
// ---------------------------------------------------------------------------

test("hai nhật ký dùng chung bộ tab và bộ nhãn, không còn chữ riêng", () => {
  const ops = readFileSync("src/app/dashboard/operations/page.tsx", "utf8");
  const ret = readFileSync("src/app/dashboard/(return-module)/returns/page.tsx", "utf8");
  const tabs = (src: string) =>
    src.slice(src.indexOf("ACTIVITY_TAB_LABEL"), src.indexOf("ACTIVITY_TAB_LABEL") + 250)
      .match(/(all|ok|duplicated|issues|staff): "[^"]+"/g);
  assert.deepEqual(tabs(ret), tabs(ops), "tên tab phải y hệt bên đóng hàng");
  for (const nhan of [
    'session_started: "Vào ca"',
    'session_ended: "Ra ca"',
    'session_forced_ended: "Đổi ca"',
    'waybill_valid: "Hợp lệ"',
    'waybill_duplicated: "Trùng"',
    'qr_invalid: "QR sai"',
  ]) {
    assert.ok(ret.includes(nhan), `nhật ký hoàn hàng thiếu nhãn dùng chung: ${nhan}`);
  }
  for (const cu of ['ok: "Hàng ổn"', 'duplicated: "Quét lại"', 'staff: "Thẻ điều khiển"']) {
    assert.ok(!ret.includes(cu), `còn tab tự chế: ${cu}`);
  }
  assert.ok(
    ret.includes("lần quét và vào/ra ca trong ngày"),
    "dòng phụ dưới tiêu đề cũng nói cùng một câu",
  );
});

test("nhật ký hoàn hàng có vào/ra ca, đọc bằng cùng hàm với đóng hàng", () => {
  const lib = readFileSync("src/lib/warehouse/live/returns.ts", "utf8");
  assert.ok(lib.includes('.from("staff_qr_scan_results")'), "tự đọc QR nhân sự — nguồn riêng");
  assert.ok(lib.includes("describeStaffScan(sr)"), "nhưng đọc ra chữ bằng hàm dùng chung");
  const act = readFileSync("src/lib/warehouse/live/activity.ts", "utf8");
  assert.ok(act.includes("export function describeStaffScan("), "hàm dùng chung nằm ở nguồn duy nhất");
  assert.ok(act.includes("({ kind, category, note } = describeStaffScan(sr));"), "đóng hàng cũng dùng đúng hàm đó");
});
