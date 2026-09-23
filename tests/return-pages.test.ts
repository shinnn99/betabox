import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { classifyReturnEvent, describeControlCard } from "../src/lib/warehouse/live/returns.ts";

/**
 * Hai trang mới của phân hệ hoàn hàng: Giám sát hoàn hàng và Bằng chứng
 * hoàn hàng.
 *
 * Chủ dự án chốt (21/09/2026): giao diện giống hệt hai trang đóng hàng,
 * chỉ khác chức năng — và là trang RIÊNG, không nhét vào trang cũ rồi đổi
 * chức năng bên trong.
 */

const MONITOR = "src/app/dashboard/(return-module)/returns/page.tsx";
const PROOF = "src/app/dashboard/(return-module)/return-videos/page.tsx";
const OLD_MONITOR = "src/app/dashboard/operations/page.tsx";
const OLD_PROOF = "src/app/dashboard/videos/page.tsx";

// ---------------------------------------------------------------------------
// Tách riêng: trang cũ không biết gì về hàng hoàn, trang mới không gọi API cũ.
// ---------------------------------------------------------------------------

test("hai trang đóng hàng cũ không chứa gì của phân hệ hoàn hàng", () => {
  for (const file of [OLD_MONITOR, OLD_PROOF]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("/api/returns"), `${file} không được gọi API hoàn hàng`);
    assert.ok(!source.includes("ReturnCapture"), `${file} không được chứa phiên nhận hoàn`);
    assert.ok(!source.includes("flow="), `${file} không được có công tắc đổi luồng`);
  }
});

test("hai trang hoàn hàng là file riêng, chỉ gọi API của phân hệ hoàn hàng", () => {
  const monitor = readFileSync(MONITOR, "utf8");
  assert.ok(monitor.includes("/api/returns/live/overview"));
  assert.ok(monitor.includes("/api/returns/live/proof-size-risk"));
  assert.ok(!monitor.includes("/api/warehouse/live/"), "không được đọc dữ liệu giám sát đóng hàng");

  const proof = readFileSync(PROOF, "utf8");
  assert.ok(proof.includes("/api/returns/proof/scans"));
  assert.ok(proof.includes("/api/returns/claims/bulk"));
  assert.ok(
    !proof.includes("/api/order-proof/scans/mark-error"),
    "kiện hoàn không bao giờ được đánh dấu Đơn lỗi",
  );
});

test("giao diện giữ y hệt: cùng khung, cùng lưới, cùng bảng", () => {
  // Không so từng byte (chức năng khác thì chữ khác), nhưng các khối
  // khung phải có mặt ở cả hai bản.
  const pairs: Array<[string, string, string[]]> = [
    [
      OLD_MONITOR,
      MONITOR,
      [
        'className="grid grid-cols-2 lg:grid-cols-4 gap-3"',
        'className="grid grid-cols-1 lg:grid-cols-5 gap-3"',
        "<StationLivePanel",
        "startVisibilityPolling",
        "ProofSizeBadge",
        "Tải thêm",
        "Về hôm nay",
      ],
    ],
    [
      OLD_PROOF,
      PROOF,
      ["<SearchBar", "<ListView", "<GridView", "<PlayerModal", "<BulkActionBar", "useWatchClipState"],
    ],
  ];
  for (const [oldFile, newFile, markers] of pairs) {
    const oldSrc = readFileSync(oldFile, "utf8");
    const newSrc = readFileSync(newFile, "utf8");
    for (const m of markers) {
      assert.ok(oldSrc.includes(m), `${oldFile} thiếu ${m} — cập nhật test`);
      assert.ok(newSrc.includes(m), `${newFile} lệch khung so với ${oldFile}: thiếu ${m}`);
    }
  }
});

test("sidebar có hai mục riêng, URL không lồng nhau", () => {
  // Đọc nguồn thay vì import: nav.ts kéo theo thư viện icon (cần React
  // client), không chạy được dưới điều kiện react-server của bộ test.
  const nav = readFileSync("src/lib/nav.ts", "utf8");
  assert.match(nav, /label: "Giám sát hoàn hàng",\s*href: "\/dashboard\/returns",/);
  assert.match(nav, /label: "Bằng chứng hoàn hàng",\s*href: "\/dashboard\/return-videos",/);
  assert.ok(!nav.includes('label: "Hàng hoàn"'), "mục Hàng hoàn cũ phải được thay");
  // Sidebar đánh dấu mục đang mở theo tiền tố — lồng nhau là sáng nhầm mục.
  assert.ok(!"/dashboard/return-videos".startsWith("/dashboard/returns/"));
});

test("hai trang hoàn hàng chung một layout giữ phiên nhận hoàn", () => {
  const layout = "src/app/dashboard/(return-module)/layout.tsx";
  assert.ok(existsSync(layout));
  assert.ok(readFileSync(layout, "utf8").includes("<ReturnCaptureProvider>"));
  // Trang không tự giữ nhịp — nếu có, chuyển trang là đứt phiên.
  for (const file of [MONITOR, PROOF]) {
    assert.ok(!readFileSync(file, "utf8").includes('action: "heartbeat"'), file);
  }
  assert.ok(!existsSync("src/app/dashboard/returns/page.tsx"), "trang Hàng hoàn cũ phải được gỡ");
});

// ---------------------------------------------------------------------------
// Sửa kèm: kiện hoàn không lọt vào luồng đóng hàng.
// ---------------------------------------------------------------------------

test("danh sách bằng chứng mặc định chỉ đơn đi; route hoàn hàng khoá cứng kiện hoàn", () => {
  const service = readFileSync("src/lib/order-proof/service.ts", "utf8");
  assert.ok(service.includes(`const eventKind = filter.eventKind ?? "outbound"`));
  assert.ok(service.includes(`.eq("event_kind", eventKind)`));
  const route = readFileSync("src/app/api/returns/proof/scans/route.ts", "utf8");
  assert.ok(route.includes(`eventKind: "return"`));
  const oldRoute = readFileSync("src/app/api/order-proof/scans/route.ts", "utf8");
  assert.ok(!oldRoute.includes("eventKind"), "route đóng hàng không được đổi luồng qua tham số");
});

test("Đánh dấu lỗi chỉ chạm đơn đi", () => {
  const source = readFileSync("src/app/api/order-proof/scans/mark-error/route.ts", "utf8");
  assert.ok(source.includes(`.eq("event_kind", "outbound")`));
});

test("ước lượng dung lượng clip: route đóng hàng chỉ ước lượng đơn đi", () => {
  const oldRoute = readFileSync("src/app/api/warehouse/live/proof-size-risk/route.ts", "utf8");
  assert.ok(oldRoute.includes(`eventKind: "outbound"`));
  const newRoute = readFileSync("src/app/api/returns/live/proof-size-risk/route.ts", "utf8");
  assert.ok(newRoute.includes(`eventKind: "return"`));
});

test("nhật ký đóng hàng gắn nhãn kiện hoàn và thẻ điều khiển, không gọi là Hợp lệ", () => {
  const source = readFileSync("src/lib/warehouse/live/activity.ts", "utf8");
  const returnBranch = source.indexOf(`pe.event_kind === "return" && pe.status !== "return_suspect"`);
  const validBranch = source.indexOf(`} else if (pe.status === "valid") {`);
  assert.ok(returnBranch > 0 && validBranch > returnBranch, "nhánh kiện hoàn phải đứng TRƯỚC nhánh Hợp lệ");
  assert.ok(source.includes(`r.scan_type === "control"`), "thẻ điều khiển phải có nhánh riêng");
});

// ---------------------------------------------------------------------------
// Phân loại một kiện hoàn thành một dòng nhật ký.
// ---------------------------------------------------------------------------

const base = {
  status: "valid",
  timing_status: "return_closed",
  return_kind: "rts",
  inspection_result: "ok",
  close_reason: "result_card",
};

test("kiện hoàn dùng chung bộ nhãn với đóng hàng, không đặt loại riêng", () => {
  // Chi tiết từng trạng thái: tests/return-dot7-nhat-ky-bao-cao.test.ts.
  // Ở đây chỉ canh không ai lặng lẽ thêm lại loại riêng cho hàng hoàn.
  for (const e of [
    base,
    { ...base, timing_status: "open", inspection_result: null, close_reason: null },
    { ...base, inspection_result: "swapped" },
    { ...base, status: "duplicated_return" },
    { ...base, status: "return_suspect" },
    { ...base, status: "no_active_session" },
  ]) {
    const r = classifyReturnEvent(e);
    assert.ok(r.kind.startsWith("waybill_"), `loại phải là loại của đóng hàng, đang là ${r.kind}`);
  }
});

test("thẻ điều khiển đọc ra tên người dùng hiểu", () => {
  assert.equal(describeControlCard("BETABOX:MODE:RETURN"), "Thẻ NHẬN HOÀN");
  assert.equal(describeControlCard("BETABOX:MODE:OUTBOUND"), "Thẻ ĐÓNG HÀNG");
  assert.equal(describeControlCard("BETABOX:RESULT:SWAPPED"), "Thẻ kết quả: Tráo");
  assert.equal(describeControlCard("BETABOX:END"), "Thẻ KẾT THÚC");
  assert.equal(describeControlCard("BETABOX:XYZ"), "Thẻ điều khiển không hợp lệ");
});
