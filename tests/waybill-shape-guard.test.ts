import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWaybillLike, toWaybillCandidate } from "@/lib/warehouse/waybill-shape";

/**
 * Chuỗi không có dáng mã vận đơn thì KHÔNG được vào database.
 *
 * Sự cố kho Đại Kim 25/09/2026: nhãn TikTok in hai mã QR — mã vận đơn và
 * một mã link tới trang shop. Camera đọc trúng cái link
 * `https://m.tiktok.shop/s/ALIfL0VLNKnL`; hệ thống nhận bừa làm mã vận
 * đơn, tạo một "đơn đi" hồi 27/08. Một tháng sau, mỗi lần cái nhãn đó lọt
 * vào khung camera là lưới an toàn lại thấy "mã đã gửi đi bị quét lại" và
 * ghi thành HÀNG HOÀN — 17 kiện hoàn ma, lẫn vào nhật ký đóng hàng.
 *
 * Chặn ở BA tầng, và test này giữ cả ba:
 *   1. Cửa vào (route `scans` và `manual-scan`): chuỗi rớt luật thì dừng
 *      ngay, không ghi cả lượt quét thô.
 *   2. Database (`process_waybill_scan`): chốt chặn cuối cho agent đời cũ
 *      hoặc đường nào lọt qua tầng 1.
 *   3. Máy kho (`warehouse-agent/src/qr/code-pick.ts`): bỏ QR đường link
 *      trước khi gửi, để mã vận đơn in ngay cạnh được chọn.
 *
 * Chủ dự án chốt 25/09/2026: "những cái đơn mã sai tôi đã bảo không nhận
 * cũng không lưu vào database mà" — tầng 2 một mình là chưa đủ, vì nó ghi
 * lượt quét rồi mới gắn nhãn `invalid_code`.
 */

const SQL = readFileSync(
  "supabase/migrations/20260925120000_reject_non_waybill_scans.sql",
  "utf8",
);

test("luật trong SQL và luật trong mã nguồn phải khớp nhau", () => {
  assert.ok(SQL.includes("length(p_value) BETWEEN 8 AND 40"));
  assert.ok(SQL.includes("'^[A-Z0-9][A-Z0-9._-]*$'"));
  // Phải thay đúng chỗ quyết định trạng thái, không chỉ thêm hàm rồi bỏ đó.
  assert.ok(SQL.includes("if not public.is_waybill_like(v_waybill) then"));
  assert.ok(!SQL.includes("if v_waybill = '' then"), "bỏ hẳn luật cũ chỉ chặn chuỗi rỗng");
  // Bản TS phải chuẩn hoá y như SQL: upper(trim(raw_value)).
  assert.ok(SQL.includes("upper(trim(v_raw.raw_value))"));
  assert.equal(toWaybillCandidate("  ttvn1111790805 "), "TTVN1111790805");
});

test("mã vận đơn thật của các sàn đều qua được", () => {
  for (const ma of [
    "862487244176", // J&T
    "260924UUVC54EF",
    "SPXVN060122245929", // Shopee
    "TTVN1111790805", // TikTok
    "LEX123456789",
    "854160978771",
    "26092305MYXBJT",
  ]) {
    assert.equal(isWaybillLike(ma), true, `phải nhận mã thật: ${ma}`);
  }
});

test("đường link và rác bị chặn", () => {
  for (const rac of [
    "HTTPS://M.TIKTOK.SHOP/S/ALIFL0VLNKNL", // đúng chuỗi đã gây sự cố
    "HTTP://EXAMPLE.COM",
    "HTTPS://SHOPEE.VN/ABC",
    "", // chuỗi rỗng
    "ABC", // quá ngắn
    "BAN 01", // có khoảng trắng
    "MÃ TIẾNG VIỆT",
    "A".repeat(41), // quá dài
  ]) {
    assert.equal(isWaybillLike(rac), false, `phải chặn: "${rac}"`);
  }
});

test("chuỗi bị chặn thì thành mã sai, KHÔNG thành kiện hoàn", () => {
  // Điều kiện nằm TRƯỚC nhánh lưới an toàn, nên URL không bao giờ đẻ ra
  // kiện hoàn — đúng cái đã xảy ra ở kho.
  const viTriChan = SQL.indexOf("if not public.is_waybill_like(v_waybill) then");
  const viTriLuoiAnToan = SQL.indexOf("v_status := 'return_suspect'");
  assert.ok(viTriChan > 0 && viTriLuoiAnToan > 0);
  assert.ok(viTriChan < viTriLuoiAnToan, "phải chặn TRƯỚC khi xét lưới an toàn");
});

test("nhánh mã sai không được làm vỡ hàm xử lý lượt quét", () => {
  // `v_resolved` chỉ gán ở nhánh mã hợp lệ, nhưng câu INSERT cuối hàm LUÔN
  // đọc nó. Không gán trước là PL/pgSQL ném "record is not assigned yet",
  // hàm vỡ và lượt quét mất trắng — tệ hơn cả lỗi đang đi sửa.
  const va = readFileSync(
    "supabase/migrations/20260925130000_fix_invalid_code_crash.sql",
    "utf8",
  );
  assert.ok(
    va.includes("select null::uuid as st_id, null::uuid as wh_id into v_resolved;"),
    "phải gán sẵn v_resolved trước khi rẽ nhánh",
  );
  const viTriGan = va.indexOf("into v_resolved;");
  const viTriChan = va.indexOf("if not public.is_waybill_like(v_waybill) then");
  assert.ok(viTriGan > 0 && viTriChan > 0);
  assert.ok(viTriGan < viTriChan, "phải gán TRƯỚC nhánh kiểm tra mã");
});

// ---------------------------------------------------------------------------
// Tầng 1: cửa vào. Không ghi lượt quét thô nào.
// ---------------------------------------------------------------------------

test("route nhận lượt quét từ máy kho: chặn TRƯỚC khi ghi lượt quét thô", () => {
  const route = readFileSync("src/app/api/warehouse/scans/route.ts", "utf8");
  const viTriChan = route.indexOf("!isWaybillLike(toWaybillCandidate(parsed.raw_value))");
  const viTriGhi = route.indexOf(`.from("warehouse_scan_raw_events")`);
  assert.ok(viTriChan > 0, "phải có chốt chặn ở cửa vào");
  assert.ok(viTriGhi > 0);
  assert.ok(viTriChan < viTriGhi, "chặn phải đứng TRƯỚC câu ghi, không thì vẫn lưu");
});

test("route máy kho trả ok chứ không trả lỗi", () => {
  // Agent có hàng đợi gửi lại. Trả lỗi là nó thử lại mãi một chuỗi vĩnh
  // viễn không hợp lệ — hàng đợi tắc, lượt quét thật xếp sau bị chậm.
  const route = readFileSync("src/app/api/warehouse/scans/route.ts", "utf8");
  const doan = route.slice(
    route.indexOf("!isWaybillLike(toWaybillCandidate(parsed.raw_value))"),
    route.indexOf(`.from("warehouse_scan_raw_events")`),
  );
  assert.ok(doan.includes("ok: true"), "phải trả ok: true");
  assert.ok(doan.includes(`ignored: "not_waybill"`));
  assert.ok(!doan.includes("status: 4"), "không trả mã lỗi 4xx cho agent");
});

test("route gõ tay trên trình duyệt: chặn TRƯỚC khi ghi, và báo lỗi ra màn hình", () => {
  const route = readFileSync("src/app/api/warehouse/manual-scan/route.ts", "utf8");
  const viTriChan = route.indexOf("!isWaybillLike(toWaybillCandidate(rawValue))");
  const viTriGhi = route.indexOf(`.from("warehouse_scan_raw_events")`);
  assert.ok(viTriChan > 0, "phải có chốt chặn");
  assert.ok(viTriGhi > 0);
  assert.ok(viTriChan < viTriGhi, "chặn phải đứng TRƯỚC câu ghi");
  // Người gõ tay thì phải được báo ngay, khác với agent.
  const doan = route.slice(viTriChan, viTriGhi);
  assert.ok(doan.includes("status: 400"), "người gõ tay phải nhận lỗi rõ ràng");
});
