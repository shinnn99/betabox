import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Chuỗi không có dáng mã vận đơn thì không được tạo đơn.
 *
 * Sự cố kho Đại Kim 25/09/2026: nhãn TikTok in hai mã QR — mã vận đơn và
 * một mã link tới trang shop. Camera đọc trúng cái link
 * `https://m.tiktok.shop/s/ALIfL0VLNKnL`; hệ thống nhận bừa làm mã vận
 * đơn, tạo một "đơn đi" hồi 27/08. Một tháng sau, mỗi lần cái nhãn đó lọt
 * vào khung camera là lưới an toàn lại thấy "mã đã gửi đi bị quét lại" và
 * ghi thành HÀNG HOÀN — 8 kiện hoàn ma trong một buổi sáng, lẫn vào nhật
 * ký đóng hàng.
 */

const SQL = readFileSync(
  "supabase/migrations/20260925100000_reject_non_waybill_scans.sql",
  "utf8",
);

/** Bản sao luật trong SQL, để kiểm được từng chuỗi cụ thể. */
function isWaybillLike(value: string): boolean {
  return value.length >= 8 && value.length <= 40 && /^[A-Z0-9][A-Z0-9._-]*$/.test(value);
}

test("luật trong SQL và luật kiểm ở đây phải khớp nhau", () => {
  assert.ok(SQL.includes("length(p_value) BETWEEN 8 AND 40"));
  assert.ok(SQL.includes("'^[A-Z0-9][A-Z0-9._-]*$'"));
  // Phải thay đúng chỗ quyết định trạng thái, không chỉ thêm hàm rồi bỏ đó.
  assert.ok(SQL.includes("if not public.is_waybill_like(v_waybill) then"));
  assert.ok(!SQL.includes("if v_waybill = '' then"), "bỏ hẳn luật cũ chỉ chặn chuỗi rỗng");
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
    "supabase/migrations/20260925110000_fix_invalid_code_crash.sql",
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
