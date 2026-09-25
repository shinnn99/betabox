import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Nhật ký "Hoạt động hôm nay" của đóng hàng không được lẫn kiện hoàn.
 *
 * Sự cố kho Đại Kim 25/09/2026: chủ kho mở nhật ký đóng hàng và thấy 17
 * dòng gắn nhãn "Hàng hoàn", mã vận đơn là một đường link TikTok, bắt đầu
 * và kết thúc trùng nhau nên thời gian đóng là 0 giây.
 *
 * Hai lỗi chồng lên nhau, và đây là test cho lỗi thứ hai:
 *   1. Camera đọc trúng mã QR link trên nhãn TikTok → chặn ở migration
 *      20260925100000 (xem waybill-shape-guard.test.ts).
 *   2. Nhật ký đóng hàng liệt kê MỌI lượt quét trong ngày rồi mới phân
 *      loại, nên lượt quét của luồng hoàn hàng vẫn hiện ở đây — kể cả khi
 *      mã hoàn toàn hợp lệ. Luồng hoàn đã có bảng riêng
 *      (`buildReturnActivity`), để lẫn là đếm hai lần và đọc sai ca làm.
 *
 * Test đọc mã nguồn vì truy vấn chạy trong PostgREST: gọi thẳng
 * `buildLiveActivity` trong test thuần thì cần cả database.
 */

const SRC = readFileSync("src/lib/warehouse/live/activity.ts", "utf8");
const RETURNS = readFileSync("src/lib/warehouse/live/returns.ts", "utf8");

test("nhật ký đóng hàng lọc bỏ lượt quét của luồng hoàn", () => {
  assert.ok(
    SRC.includes(`.filter((r) => packByRaw.get(r.id)?.event_kind !== "return")`),
    "phải bỏ lượt quét có event_kind = 'return' trước khi dựng danh sách",
  );
});

test("số tổng phải trừ phần đã lọc, không đếm cả kiện hoàn", () => {
  // Đếm raw events của cả ngày rồi hiển thị bên cạnh danh sách đã lọc là
  // ra hai con số đá nhau — đúng kiểu mâu thuẫn số liệu đã đi sửa một lần.
  assert.ok(SRC.includes(`.eq("event_kind", "return")`), "cần truy vấn đếm phần hoàn");
  assert.ok(
    SRC.includes("(countRes.count ?? (raws?.length ?? 0)) - (returnCountRes.count ?? 0)"),
    "tổng hiển thị phải trừ đi số lượt hoàn",
  );
});

test("đã lọc rồi thì không còn nhánh phân loại kiện hoàn nằm lại", () => {
  // Nhánh chết gây hiểu nhầm: người đọc sau tưởng nhật ký này vẫn hiện
  // kiện hoàn và viết thêm logic quanh nó.
  assert.ok(
    !SRC.includes("classifyReturnEvent"),
    "bỏ hẳn nhánh gọi classifyReturnEvent trong nhật ký đóng hàng",
  );
});

test("bảng của luồng hoàn vẫn giữ nguyên các lượt đó", () => {
  // Lọc khỏi bên này chỉ đúng khi bên kia vẫn hiện — không thì lượt quét
  // biến mất khỏi mọi màn hình.
  assert.ok(RETURNS.includes("export function classifyReturnEvent"));
  assert.ok(RETURNS.includes(`.eq("event_kind", "return")`));
});
