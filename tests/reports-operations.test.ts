import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PACKING_EVENT_MEASURED_TIMING_STATUSES } from "@/lib/domain-status";
import { MEASURED_TIMING_IN_RPC } from "@/lib/reports/operations";
import { shiftDateKey, vnDateKey } from "@/lib/time/vietnam";

/**
 * Trang báo cáo vận hành — ba chỗ dễ sai nhất, mỗi chỗ một bài.
 *
 * Số liệu đối chứng đo trên kho Đại Kim ngày 30/09/2026:
 *   3.885 đơn valid, trong đó 1.047 capped_timeout (27%).
 */

const MIGRATION = "supabase/migrations/20260930100000_operations_report_rpcs.sql";
const RPC_NAMES = [
  "ops_report_totals",
  "ops_report_daily",
  "ops_report_hourly",
  "ops_report_stations",
  "ops_report_staff",
  "ops_report_evidence",
] as const;

test("danh sách timing ĐO ĐƯỢC khớp giữa domain-status, operations.ts và migration", () => {
  // Ba nơi cùng nói một điều. Sửa một nơi mà quên hai nơi kia thì báo cáo
  // lặng lẽ đổi mẫu số — đúng loại lỗi không ai phát hiện bằng mắt.
  assert.deepEqual(
    [...MEASURED_TIMING_IN_RPC].sort(),
    [...PACKING_EVENT_MEASURED_TIMING_STATUSES].sort(),
    "MEASURED_TIMING_IN_RPC lệch PACKING_EVENT_MEASURED_TIMING_STATUSES",
  );

  const sql = readFileSync(MIGRATION, "utf8");
  const inSql = [
    ...new Set(
      [...sql.matchAll(/timing_status IN \(([^)]+)\)/g)].map((m) =>
        m[1].replace(/['\s]/g, ""),
      ),
    ),
  ];
  assert.equal(inSql.length, 1, `migration dùng nhiều tập timing khác nhau: ${inSql}`);
  assert.deepEqual(
    inSql[0].split(",").sort(),
    [...PACKING_EVENT_MEASURED_TIMING_STATUSES].sort(),
    "migration lệch domain-status",
  );

  // capped_timeout phải được ĐẾM RIÊNG, không chỉ bị lọc khỏi percentile.
  assert.ok(
    /timing_status = 'capped_timeout'/.test(sql),
    "migration không đếm capped_timeout — 27% số đơn sẽ biến mất khỏi báo cáo",
  );
});

test("mọi RPC báo cáo đều lọc organization_id và chỉ cấp quyền service_role", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  for (const fn of RPC_NAMES) {
    const start = sql.indexOf(`FUNCTION public.${fn}(`);
    assert.ok(start >= 0, `thiếu hàm ${fn}`);
    const body = sql.slice(start, sql.indexOf("$$;", start));
    assert.ok(
      body.includes("p_organization_id"),
      `${fn} không lọc theo p_organization_id — rò dữ liệu chéo tổ chức`,
    );
    assert.ok(
      /SECURITY DEFINER/.test(body) && /SET search_path = public, pg_temp/.test(body),
      `${fn} thiếu SECURITY DEFINER + search_path cố định`,
    );
  }

  // Không mở cho authenticated: client tự chọn org khác là đọc được kho người ta.
  assert.ok(
    /FROM authenticated/.test(sql) && /TO service_role/.test(sql),
    "migration phải REVOKE authenticated và chỉ GRANT service_role",
  );
  assert.ok(
    !/TO authenticated/.test(sql),
    "không được GRANT EXECUTE cho authenticated",
  );
});

test("bucket theo giờ và đổi ngày đều dùng giờ Việt Nam, không dùng giờ process", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  // Mọi lần đụng tới timestamptz trong migration phải kèm AT TIME ZONE.
  // Cloud chạy TZ=UTC; thiếu chỗ nào là đỉnh 9h sáng hiện thành 2h sáng.
  const hourBuckets = [...sql.matchAll(/EXTRACT\(HOUR FROM ([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(hourBuckets.length > 0, "không thấy bucket theo giờ nào");
  for (const expr of hourBuckets) {
    assert.ok(
      expr.includes("AT TIME ZONE 'Asia/Ho_Chi_Minh'"),
      `bucket giờ thiếu AT TIME ZONE: ${expr}`,
    );
  }

  const dateCasts = [...sql.matchAll(/\(([^()]*started_at[^()]*)\)::date/g)].map((m) => m[1]);
  assert.ok(dateCasts.length > 0, "không thấy phép đổi started_at sang ngày");
  for (const expr of dateCasts) {
    assert.ok(
      expr.includes("AT TIME ZONE 'Asia/Ho_Chi_Minh'"),
      `đổi ngày thiếu AT TIME ZONE: ${expr}`,
    );
  }
});

test("khoảng preset tính theo lịch VN và phủ đủ số ngày, kể cả lúc sáng sớm", () => {
  // 01:30 giờ VN ngày 30/09 = 18:30 UTC ngày 29/09. Lấy ngày UTC thì "hôm
  // nay" thành 29/09 và ca sáng sớm biến mất khỏi báo cáo.
  const earlyMorningVn = Date.parse("2026-09-29T18:30:00Z");
  assert.equal(vnDateKey(earlyMorningVn), "2026-09-30");

  const to = vnDateKey(earlyMorningVn);
  const from = shiftDateKey(to, -6); // preset 7 ngày
  assert.equal(from, "2026-09-24");

  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  assert.equal(days, 7, "preset 7 ngày phải phủ đúng 7 ngày lịch, không phải 6 hay 8");
});

/**
 * Chủ dự án yêu cầu 30/09/2026: "làm toàn bộ những chỉ số này, khi di chuột
 * vào thì có giải thích chi tiết ý nghĩa chỉ số là gì".
 *
 * Bài này canh ĐỘ PHỦ, không canh câu chữ: thêm một chỉ số mới mà quên giải
 * thích thì đỏ ngay, thay vì lặng lẽ để lại một con số không ai hiểu.
 */
test("mọi chỉ số trên trang báo cáo đều có giải thích khi rê chuột", () => {
  const page = readFileSync("src/app/dashboard/reports/page.tsx", "utf8");

  // Năm ô KPI đầu trang.
  for (const label of [
    "Sản lượng đóng hàng",
    "Tổng đơn hoàn",
    "Nhịp xử lý",
    "Đơn hết giờ chờ",
    "Bằng chứng",
  ]) {
    const at = page.indexOf(`label="${label}"`);
    assert.ok(at > 0, `thiếu ô KPI ${label}`);
    // hint phải nằm trong cùng lời gọi KpiCard — cắt tới dấu đóng thẻ.
    const block = page.slice(at, page.indexOf("/>", at));
    assert.ok(block.includes('hint="'), `ô KPI "${label}" chưa có giải thích`);
  }

  // Cột bảng: <Th> không hint chỉ được phép cho cột tên riêng.
  const bareTh = [...page.matchAll(/<Th>([^<]+)<\/Th>/g)].map((m) => m[1].trim());
  assert.deepEqual(
    bareTh.sort(),
    ["Bàn", "Thành viên"],
    `cột này thiếu giải thích: ${bareTh.filter((c) => c !== "Bàn" && c !== "Thành viên")}`,
  );

  // Dấu hiệu rê-được là chấm than bên cạnh, KHÔNG phải gạch chân chấm
  // (chủ dự án chốt 30/09/2026). Gạch chân dễ đọc nhầm thành link và gần như
  // vô hình ở cỡ chữ tiêu đề cột.
  assert.ok(
    !page.includes("border-dotted"),
    "trang còn dùng gạch chân chấm làm dấu hiệu tooltip",
  );
  assert.ok(page.includes("<InfoDot"), "trang phải dùng InfoDot làm dấu hiệu");

  // Năm ô ở khối Kho bằng chứng.
  for (const label of [
    "Clip sẵn sàng",
    "Đang cắt",
    "Cắt lỗi",
    "Hết hạn lưu",
    "Khiếu nại đang mở",
  ]) {
    const at = page.indexOf(`label="${label}"`);
    assert.ok(at > 0, `thiếu ô ${label}`);
    const block = page.slice(at, page.indexOf("/>", at));
    assert.ok(block.includes('tip="'), `ô "${label}" chưa có giải thích`);
  }

  // Cột luồng hoàn KHÔNG có thì ẩn hẳn, không để cột toàn dấu gạch.
  assert.ok(
    !page.includes("emptyReason"),
    "cột không có dữ liệu phải ẩn hẳn, không để dấu gạch kèm lý do",
  );
  assert.ok(page.includes("showWorkHours"), "phải ẩn được ba cột giờ-làm");
});

/**
 * Chủ dự án 30/09/2026: "bỏ những cột không có, thêm những cột có vào như
 * p50,90 các thứ có chứ".
 *
 * Đo Đại Kim cùng ngày cho thấy luồng hoàn có cấu trúc Y HỆT đóng hàng, chỉ
 * khác tên trường: `close_reason='timeout'` chính là bản `capped_timeout` của
 * nó — 11/34 kiện, cả 11 đều đúng 300s (trần cấu hình). Nên p50/p90 và
 * hết-giờ-chờ đều tính được; chỉ ba cột giờ-làm là thật sự không có.
 */
test("bảng hoàn hàng có p50/p90 + hết-giờ-chờ, và ẩn hẳn ba cột giờ-làm", () => {
  const page = readFileSync("src/app/dashboard/reports/page.tsx", "utf8");
  const at = page.indexOf('title="Báo cáo hoàn hàng theo nhân sự"');
  assert.ok(at > 0, "thiếu bảng hoàn hàng");
  const block = page.slice(at, page.indexOf("/>", page.indexOf("unitLabel=\"kiện\"", at)));
  // Bỏ comment trước khi kiểm: chữ "showWorkHours=false" trong ghi chú không
  // phải là prop được bật.
  const code = block.replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !/\bshowWorkHours\b/.test(code),
    "bảng hoàn KHÔNG được bật ba cột giờ-làm (giờ vào ca chung cả hai luồng)",
  );
  assert.ok(block.includes("pace: s.pace"), "bảng hoàn phải nhận p50/p90 thật, không truyền null");
  assert.ok(
    block.includes("capped_orders: s.capped_orders"),
    "bảng hoàn phải nhận số kiện hết-giờ-chờ thật, không hardcode 0",
  );

  // Bảng đóng hàng thì ngược lại — phải bật.
  const outAt = page.indexOf('title="Báo cáo đóng hàng theo nhân sự"');
  assert.ok(
    page.slice(outAt, outAt + 700).includes("showWorkHours"),
    "bảng đóng hàng phải hiện ba cột giờ-làm",
  );

  // p50/p90 của luồng hoàn phải LOẠI nhóm bị ép trần, cùng nguyên tắc với
  // capped_timeout bên đóng hàng — không thì p90 = đúng trần, vô nghĩa.
  const ops = readFileSync("src/lib/reports/operations.ts", "utf8");
  assert.ok(
    /capped_orders:\s*num\(r\.capped\)/.test(ops),
    "service phải đọc cột capped của luồng hoàn",
  );
});

test("dấu hiệu tooltip là chấm than cạnh nhãn, và đọc được bằng trình đọc màn hình", () => {
  const dot = readFileSync("src/components/reports/InfoDot.tsx", "utf8");
  assert.ok(/>\s*!\s*</.test(dot), "InfoDot phải hiện dấu chấm than");
  assert.ok(dot.includes("cursor-help"), "phải đổi con trỏ để biết rê được");
  assert.ok(
    dot.includes("aria-label={hint}"),
    "chấm than là ký hiệu — thiếu aria-label thì trình đọc màn hình chỉ đọc được chữ '!'",
  );
  assert.ok(
    dot.includes("if (!hint) return null"),
    "không có giải thích thì đừng vẽ chấm than rỗng",
  );
  // Chú giải biểu đồ cũng phải bỏ gạch chân.
  const legend = readFileSync("src/components/reports/Legend.tsx", "utf8");
  assert.ok(!legend.includes("border-dotted"), "Legend còn gạch chân chấm");
  assert.ok(legend.includes("<InfoDot"), "Legend phải dùng InfoDot");
});

/**
 * Chủ dự án 30/09/2026: "có thể làm ngắn lại, nhiều hàng hơn được mà, với cả
 * cho nó nằm gần hơn các chỉ số".
 *
 * `title` của trình duyệt trải câu thành MỘT hàng chạy ngang màn hình và neo
 * theo con trỏ, nên không biết tooltip đang nói về chỉ số nào. Bản tự dựng
 * chốt bề rộng để chữ xuống dòng và neo mũi tên ngay dưới chấm than.
 */
test("tooltip bọc nhiều dòng, neo vào nhãn, và câu giải thích đủ ngắn", () => {
  const dot = readFileSync("src/components/reports/InfoDot.tsx", "utf8");
  assert.ok(
    !/title=\{hint\}/.test(dot),
    "còn dùng title của trình duyệt — nó trải một hàng dài và neo theo con trỏ",
  );
  assert.ok(dot.includes("createPortal"), "tooltip phải ra portal, không thì bị overflow của bảng cắt");
  assert.ok(
    /getBoundingClientRect/.test(dot) && /arrowLeft/.test(dot),
    "phải neo theo vị trí chấm than và có mũi tên chỉ về nhãn",
  );
  assert.ok(/width:\s*Math\.min\(280/.test(dot), "phải chốt bề rộng để chữ xuống dòng");

  // Câu quá dài thì dù có xuống dòng vẫn thành một khối chữ không ai đọc.
  const sources = [
    "src/app/dashboard/reports/page.tsx",
    "src/components/reports/DayShapeChart.tsx",
    "src/components/reports/PaceBandChart.tsx",
    "src/components/reports/VolumeChart.tsx",
  ];
  const LIMIT = 165;
  const tooLong: string[] = [];
  for (const f of sources) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:hint|tip)[=:]\s*\n?\s*[`"]([^`"]+)[`"]/g)) {
      if (m[1].length > LIMIT) tooLong.push(`${f}: ${m[1].slice(0, 50)}… (${m[1].length})`);
    }
  }
  assert.deepEqual(tooLong, [], `câu giải thích dài quá ${LIMIT} ký tự:\n${tooLong.join("\n")}`);
});

test("chú giải biểu đồ có giải thích, và không hiện nhãn sai cho luồng hoàn", () => {
  for (const f of [
    "src/components/reports/DayShapeChart.tsx",
    "src/components/reports/PaceBandChart.tsx",
    "src/components/reports/VolumeChart.tsx",
  ]) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("<Legend"), `${f} chưa dùng chú giải dùng chung`);
    const labels = [...src.matchAll(/label:\s*[`"]/g)].length;
    const hints = [...src.matchAll(/hint:\s*[`"]/g)].length;
    assert.equal(hints, labels, `${f}: ${labels} nhãn nhưng chỉ ${hints} giải thích`);
  }

  // Luồng hoàn KHÔNG có trạng thái hết-giờ-chờ — nhãn đó phải tắt được.
  const vol = readFileSync("src/components/reports/VolumeChart.tsx", "utf8");
  assert.ok(vol.includes("showCapped"), "VolumeChart phải tắt được nhãn hết-giờ-chờ");
  const page = readFileSync("src/app/dashboard/reports/page.tsx", "utf8");
  const returnChart = page.indexOf('unitLabel="kiện hoàn"');
  assert.ok(returnChart > 0, "thiếu biểu đồ hoàn hàng");
  assert.ok(
    page.slice(returnChart - 400, returnChart + 200).includes("showCapped={false}"),
    "biểu đồ hoàn hàng vẫn hiện nhãn 'hết giờ chờ' — luồng hoàn không có trạng thái này",
  );
});

test("route vận hành gác quyền report.view trước khi chạm dữ liệu", () => {
  const route = readFileSync("src/app/api/reports/operations/route.ts", "utf8");
  const guardAt = route.indexOf('requirePermission("report.view")');
  const queryAt = route.indexOf("getOperationsReport(");
  assert.ok(guardAt >= 0, "route thiếu requirePermission");
  assert.ok(queryAt > guardAt, "route gọi dữ liệu trước khi gác quyền");
});
