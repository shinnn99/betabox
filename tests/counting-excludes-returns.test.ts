import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COUNTED_OUTBOUND_EVENTS } from "@/lib/warehouse/outbound-only";

/**
 * Kiện hàng hoàn KHÔNG bao giờ được đếm vào số đơn của nhân viên.
 *
 * Vì sao là test đọc mã nguồn: kiện hoàn nằm chung bảng `packing_events`
 * với đơn đi, phân biệt bằng `event_kind`. Hiện có bốn nơi đếm đơn theo hai
 * quy tắc khác nhau (báo cáo, tổng quan, sản lượng, digest Lark) cộng bảng
 * tổng hợp Giám sát kho. Sót MỘT nơi là nhân viên được tính thêm đơn cho
 * việc mở kiện hoàn, và lỗi đó chỉ lộ ra lúc chủ kho trả công — không có
 * test đỏ, không có cảnh báo.
 *
 * Kiểm tra ở tầng nào khác cũng không bắt được: truy vấn chạy trong
 * PostgREST nên không import và gọi thẳng được trong test thuần; test tích
 * hợp thì cần cả database. Đọc mã nguồn là cách rẻ và chắc chắn bắt được
 * người thêm truy vấn mới mà quên lọc.
 *
 * Thêm một nơi đếm đơn mới → thêm vào danh sách dưới đây.
 */

const OUTBOUND_FILTER = `.eq("event_kind", "outbound")`;

/** Truy vấn đọc thẳng `packing_events` thì phải có bộ lọc loại đơn. */
const RETURN_FILTER = `.eq("event_kind", "return")`;

const FILTERED_QUERY_FILES: Array<{ file: string; expected: number; why: string }> = [
  {
    file: "src/lib/reports/service.ts",
    expected: 1,
    why: "báo cáo nhân viên (valid_orders, duplicated, lỗi)",
  },
  {
    file: "src/app/api/dashboard/overview/route.ts",
    expected: 2,
    why: "tổng quan hôm nay và hôm trước",
  },
];

// ---------------------------------------------------------------------------
// Màn hình giám sát: hàm dùng chung cho Giám sát đóng hàng và Giám sát hoàn
// hàng, nhận luồng làm tham số. Canh ba điều:
//   1. mọi truy vấn packing_events lọc theo đúng luồng;
//   2. luồng mặc định là ĐƠN ĐI;
//   3. route của Giám sát đóng hàng không truyền luồng khác.
// Thẻ bàn (stations.ts) trước đây KHÔNG lọc gì — "Hôm nay N đơn" cộng lẫn
// kiện hoàn. Giờ canh luôn.
// ---------------------------------------------------------------------------

for (const file of [
  "src/lib/warehouse/live/summary.ts",
  "src/lib/warehouse/live/stations.ts",
]) {
  test(`${file} lọc đúng luồng, mặc định đơn đi`, () => {
    const source = readFileSync(file, "utf8");
    const queries = source.split(`.from("packing_events")`).length - 1;
    const filters = source.split(`.eq("event_kind", flow)`).length - 1;
    assert.ok(queries > 0);
    assert.equal(filters, queries, "có truy vấn packing_events chưa lọc theo luồng");
    assert.ok(
      source.includes(`flow: LiveFlow = "outbound"`),
      "luồng mặc định phải là đơn đi — gọi quên tham số không được đếm lẫn kiện hoàn",
    );
  });
}

test("Giám sát đóng hàng gọi các hàm dùng chung với luồng đơn đi", () => {
  const source = readFileSync("src/app/api/warehouse/live/overview/route.ts", "utf8");
  assert.ok(source.includes("buildLiveSummary(admin, orgId)"), "summary phải dùng luồng mặc định");
  assert.ok(source.includes("buildLiveStations(admin, orgId)"), "stations phải dùng luồng mặc định");
  assert.ok(!source.includes(`"return"`), "route đóng hàng không được nhắc tới luồng hoàn");
});

for (const target of FILTERED_QUERY_FILES) {
  test(`${target.file} chỉ đếm đơn đi (${target.why})`, () => {
    const source = readFileSync(target.file, "utf8");
    const filters = source.split(OUTBOUND_FILTER).length - 1;
    assert.equal(
      filters,
      target.expected,
      `thiếu bộ lọc ${OUTBOUND_FILTER} — kiện hoàn sẽ bị đếm vào số đơn`,
    );

    // Mỗi truy vấn packing_events phải khai rõ luồng: đơn đi cho số sản
    // lượng, hoặc kiện hoàn cho khung Hàng hoàn của báo cáo (đợt 7).
    const queries = source.split(`.from("packing_events")`).length - 1;
    const returnFilters = source.split(RETURN_FILTER).length - 1;
    assert.equal(
      queries,
      target.expected + returnFilters,
      "số truy vấn packing_events khác số bộ lọc — có truy vấn chưa lọc loại đơn",
    );
  });
}

test("biểu đồ sản lượng đọc view chỉ chứa đơn đi hợp lệ", () => {
  const source = readFileSync("src/app/api/dashboard/production/route.ts", "utf8");
  assert.ok(
    source.includes("COUNTED_OUTBOUND_EVENTS"),
    "sản lượng phải đọc view counted_outbound_events",
  );
  assert.ok(
    !source.includes(`.from("packing_events")`),
    "sản lượng không được đọc thẳng packing_events",
  );
});

test("digest Lark chỉ đếm đơn đi", () => {
  const migration = readFileSync(
    "supabase/migrations/20260921090000_return_flow_base.sql",
    "utf8",
  );
  const digest = migration.slice(migration.indexOf("lark_digest_per_staff"));
  assert.ok(
    digest.includes("pe.event_kind = 'outbound'"),
    "RPC lark_digest_per_staff phải lọc event_kind",
  );
});

test("view đếm đơn loại cả kiện hoàn lẫn lượt quét lỗi", () => {
  const migration = readFileSync(
    "supabase/migrations/20260921090000_return_flow_base.sql",
    "utf8",
  );
  assert.ok(
    migration.includes(`CREATE VIEW public.${COUNTED_OUTBOUND_EVENTS}`),
    "migration phải tạo view đếm đơn",
  );
  assert.ok(
    /WHERE status = 'valid' AND event_kind = 'outbound'/.test(migration),
    "view phải lọc đúng: chỉ đơn đi hợp lệ",
  );
});
