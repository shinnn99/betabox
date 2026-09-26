import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHECK_CONFIG,
  checkIgnoredScans,
  ignoredScanEntity,
  type IgnoredScanRow,
  type MonitoringScope,
} from "@/lib/system/checks";
import { describeSourceDisabled } from "@/lib/warehouse/live/activity";
import { isMissingColumnError } from "@/lib/supabase/missing-column";

/**
 * Đợt 5 — kế hoạch VAN-HANH-NHIEU-KHO: cloud GHI LẠI lý do khi bỏ lượt quét
 * (trước đây biết rồi vứt đi — nhật ký gắn "Mã sai"), và mục kiểm chỉ báo
 * khi lượt bị bỏ làm MẤT ĐƠN thật.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-09-26T09:00:00Z");

const row = (p: Partial<IgnoredScanRow> = {}): IgnoredScanRow => ({
  organization_id: ORG,
  scanner_device_code: "MAY_QUET_01",
  raw_value: "SPXVN061234567",
  normalized_value: "SPXVN061234567",
  scan_type: "waybill",
  source: "serial",
  ...p,
});

// ── Nhật ký: nói đúng nguồn nào bị tắt ─────────────────────────────────

test("câu nhật ký nói rõ nguồn nào bị tắt và hậu quả", () => {
  assert.equal(
    describeSourceDisabled("serial", false),
    "Quét bằng súng, nhưng bàn đang đặt nguồn quét là camera — không tạo đơn.",
  );
  assert.equal(
    describeSourceDisabled("camera_qr", false),
    "Camera đọc được mã, nhưng bàn đang đặt nguồn quét là súng quét — không tạo đơn.",
  );
  assert.match(describeSourceDisabled("hid_keyboard", true), /không vào \/ ra ca/);
});

test("nhật ký: lượt có lý do không còn rơi vào 'Mã sai' / 'Đang chờ xử lý'", () => {
  const src = readFileSync("src/lib/warehouse/live/activity.ts", "utf8");
  // Hành vi của nhãn mồ côi kiểm ở tests/scan-incident-fixes.test.ts
  // (describeOrphanScan); ở đây chỉ canh nhật ký dùng đúng hàm đó.
  assert.ok(src.includes("const orphanNote = describeOrphanScan({"));
  // Chưa có cột → đọc lại không có cột, nhật ký không gãy.
  assert.ok(src.includes('isMissingColumnError(firstRawsRes.error, "ignored_reason")'));
  for (const page of ["src/app/dashboard/operations/page.tsx", "src/app/dashboard/(return-module)/returns/page.tsx"]) {
    assert.ok(readFileSync(page, "utf8").includes('waybill_source_disabled: "Nguồn quét tắt"'), page);
  }
});

// ── Route quét: luồng đóng hàng không đổi ──────────────────────────────

test("route quét: CHỈ lượt bị bỏ mang cột mới; chưa có cột thì lùi về câu cũ", () => {
  const src = readFileSync("src/app/api/warehouse/scans/route.ts", "utf8");
  assert.ok(
    src.includes('scanSourceDisabled ? { ...rawRow, ignored_reason: "scan_source_disabled" } : rawRow'),
    "lượt quét bình thường phải ghi đúng câu cũ — luồng đóng hàng không phụ thuộc migration",
  );
  assert.ok(src.includes('scanSourceDisabled && isMissingColumnError(result.error, "ignored_reason")'));
  assert.ok(src.includes("result = await insertRaw(rawRow);"));
});

test("nhận diện thiếu cột: theo TÊN cột, không nuốt lỗi khác", () => {
  const pgrst = { code: "PGRST204", message: "Could not find the 'ignored_reason' column of 'warehouse_scan_raw_events' in the schema cache" };
  const pg = { code: "42703", message: "column warehouse_scan_raw_events.ignored_reason does not exist" };
  assert.equal(isMissingColumnError(pgrst, "ignored_reason"), true);
  assert.equal(isMissingColumnError(pg, "ignored_reason"), true);
  assert.equal(isMissingColumnError(pg, "mac_address"), false, "thiếu cột KHÁC không được nuốt");
  assert.equal(isMissingColumnError({ code: "23505", message: "duplicate key ignored_reason" }, "ignored_reason"), false);
  assert.equal(isMissingColumnError(null, "ignored_reason"), false);
});

// ── Mục kiểm: đếm ĐƠN MẤT, không đếm lượt bị bỏ ────────────────────────

test("không có lượt bị bỏ → ok", () => {
  const e = ignoredScanEntity(ORG, [], new Set());
  assert.equal(e.status, "ok");
  assert.equal(e.count, 0);
});

test("bị bỏ nhưng camera đã quét lại cùng mã → ok, KHÔNG báo", () => {
  const e = ignoredScanEntity(ORG, [row(), row()], new Set([`${ORG}|SPXVN061234567`]));
  assert.equal(e.status, "ok");
  assert.match(e.detail, /mọi mã đã thành đơn/);
});

test("một mã bị bỏ và không thành đơn → warn, nêu mã + thiết bị + việc cần làm", () => {
  const e = ignoredScanEntity(ORG, [row(), row()], new Set());
  assert.equal(e.status, "warn");
  assert.equal(e.count, 1, "cùng một mã quét hai lần là MỘT đơn mất");
  assert.match(e.detail, /SPXVN061234567/);
  assert.match(e.detail, /MAY_QUET_01/);
  assert.match(e.action ?? "", /quét bằng súng ở bàn đang đặt nguồn quét là camera/);
});

test("đơn đã thành ở TỔ CHỨC KHÁC không được tính là đã thành", () => {
  const e = ignoredScanEntity(ORG, [row()], new Set([`${OTHER}|SPXVN061234567`]));
  assert.equal(e.status, "warn");
});

test(`từ ${CHECK_CONFIG.ignoredScans.critLost} đơn mất → crit`, () => {
  const rows = ["A1111111", "B2222222", "C3333333"].map((c) => row({ raw_value: c, normalized_value: c }));
  assert.equal(ignoredScanEntity(ORG, rows, new Set()).status, "crit");
});

test("camera đọc ở bàn đặt súng → câu cần làm nói về camera", () => {
  const e = ignoredScanEntity(ORG, [row({ source: "camera_qr", scanner_device_code: "qrcam_CQR01" })], new Set());
  assert.match(e.action ?? "", /Camera đọc được mã ở bàn đang đặt nguồn quét là súng/);
});

test("QR nhân sự bị bỏ không tính là đơn mất", () => {
  const e = ignoredScanEntity(ORG, [row({ scan_type: "staff_qr" })], new Set());
  assert.equal(e.status, "ok");
});

test("nhiều mã: kể 5 mã đầu rồi 'và N mã khác'", () => {
  const rows = Array.from({ length: 7 }, (_, i) => row({ raw_value: `CODE${i}000`, normalized_value: `CODE${i}000` }));
  const e = ignoredScanEntity(ORG, rows, new Set());
  assert.equal(e.count, 7);
  assert.match(e.detail, /và 2 mã khác/);
});

// ── Chạy cả mục với database giả ───────────────────────────────────────

const scope: MonitoringScope = {
  orgIds: [ORG],
  orgNameById: new Map([[ORG, "Shop A"]]),
  warehouseNamesByOrg: new Map(),
  lastScanByOrg: new Map(),
};

function fakeDb(opts: { raws?: IgnoredScanRow[]; rawError?: { code?: string; message: string }; events?: unknown[] }) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "not", "gte", "in", "limit", "abortSignal", "eq", "order"]) q[m] = () => q;
      q.then = (res: (v: unknown) => void) => {
        if (table === "warehouse_scan_raw_events") {
          return res(opts.rawError ? { data: null, error: opts.rawError } : { data: opts.raws ?? [], error: null });
        }
        return res({ data: opts.events ?? [], error: null });
      };
      return q;
    },
  } as never;
}

test("chưa chạy migration → 'chưa đo được' dạng cấu trúc (không báo động), nói rõ migration nào", async () => {
  const c = await checkIgnoredScans(
    fakeDb({ rawError: { code: "42703", message: "column warehouse_scan_raw_events.ignored_reason does not exist" } }),
    NOW,
    scope,
  );
  assert.equal(c.status, "unknown");
  assert.equal(c.unknownKind, "structural");
  assert.match(c.message, /20260926110000/);
});

test("lỗi đọc thật thì ném — safeCheck biến thành 'mất nguồn', không nuốt thành ok", async () => {
  await assert.rejects(checkIgnoredScans(fakeDb({ rawError: { message: "timeout" } }), NOW, scope), /timeout/);
});

test("cả mục: một đơn mất → warn, tên kho trong câu", async () => {
  const c = await checkIgnoredScans(fakeDb({ raws: [row()], events: [] }), NOW, scope);
  assert.equal(c.status, "warn");
  assert.match(c.message, /Shop A/);
  assert.match(c.value, /1 đơn mất/);
});

test("cả mục: bị bỏ nhưng đã thành đơn → ok", async () => {
  const c = await checkIgnoredScans(
    fakeDb({ raws: [row()], events: [{ organization_id: ORG, waybill_code: "SPXVN061234567" }] }),
    NOW,
    scope,
  );
  assert.equal(c.status, "ok");
  assert.match(c.value, /1 lượt bị bỏ, 0 đơn mất/);
});

test("migration: cột có danh sách lý do đóng, index một phần", () => {
  const sql = readFileSync("supabase/migrations/20260926110000_scan_ignored_reason.sql", "utf8");
  assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS ignored_reason text NULL"));
  assert.ok(sql.includes("CHECK (ignored_reason IS NULL OR ignored_reason IN ('scan_source_disabled'))"));
  assert.ok(sql.includes("WHERE ignored_reason IS NOT NULL"));
  assert.ok(!/UPDATE\s+public\.warehouse_scan_raw_events/i.test(sql), "không đụng dữ liệu cũ");
});
