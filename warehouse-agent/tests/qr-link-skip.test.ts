import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeLink, pickScanCode, type CodeCandidate } from "../src/qr/code-pick";
import { QrZone } from "../src/qr/qr-zone";

/**
 * Nhãn TikTok in HAI mã QR cạnh nhau: mã vận đơn và một mã link tới trang
 * shop. Agent phải bỏ cái link và lấy mã vận đơn.
 *
 * Chủ dự án báo 25/09/2026: "hệ thống nhận diện đang quét cả QR của đường
 * link... khi bắt được QR link thì bỏ qua, chỉ nhận QR mã vận đơn".
 *
 * Trước bản sửa có hai đường hỏng, test dưới đây khoá cả hai:
 *   - camera bắt trúng link trước → gửi link lên, mã vận đơn mất;
 *   - hai mã ngang cơ trong khung → rơi vào nhánh "hai nhãn cùng lúc",
 *     không gửi gì cả, nhân viên quét mãi không ăn.
 */

const qr = (text: string, size: number): CodeCandidate => ({
  text,
  box: { x: 0, y: 0, width: size, height: size },
  kind: "qr",
});

test("đúng chuỗi đã gây sự cố bị nhận là link", () => {
  assert.equal(looksLikeLink("https://m.tiktok.shop/s/ALIfL0VLNKnL"), true);
});

test("các dạng link khác cũng bị nhận", () => {
  for (const link of [
    "http://example.com",
    "HTTPS://SHOPEE.VN/ABC",
    "www.tiktok.com/xyz",
    "m.tiktok.shop/s/ALIfL0VLNKnL", // thiếu cả https://
    "shopee.vn/product/123",
    "tiki.vn",
  ]) {
    assert.equal(looksLikeLink(link), true, `phải nhận là link: ${link}`);
  }
});

test("mã vận đơn thật KHÔNG bị nhận nhầm là link", () => {
  // Đây là chỗ nguy hiểm: lọc rộng tay là tự chặn chính mình, cả kho
  // không quét được đơn nào.
  for (const ma of [
    "862487244176",
    "260924UUVC54EF",
    "SPXVN060122245929",
    "TTVN1111790805",
    "LEX123456789",
    "26092305MYXBJT",
    "SPX.VN123456",
    "J&T-854160978771".replace("&", ""),
  ]) {
    assert.equal(looksLikeLink(ma), false, `không được coi là link: ${ma}`);
  }
});

test("có link lẫn mã vận đơn trong khung thì lấy mã vận đơn", () => {
  const picked = pickScanCode([
    qr("https://m.tiktok.shop/s/ALIfL0VLNKnL", 40),
    qr("TTVN1111790805", 40),
  ]);
  assert.equal(picked.picked?.text, "TTVN1111790805");
  assert.notEqual(picked.ambiguous, true, "không được coi là hai nhãn cùng lúc");
});

test("link to hơn mã vận đơn vẫn thua", () => {
  const picked = pickScanCode([
    qr("https://m.tiktok.shop/s/ALIfL0VLNKnL", 120),
    qr("TTVN1111790805", 30),
  ]);
  assert.equal(picked.picked?.text, "TTVN1111790805");
});

test("trong khung chỉ có mỗi link thì không gửi gì", () => {
  assert.deepEqual(pickScanCode([qr("https://m.tiktok.shop/s/ALIfL0VLNKnL", 60)]), {});
});

test("cả máy trạng thái vùng quét cũng nhả ra mã vận đơn, không phải link", () => {
  // pickScanCode đúng mà QrZone vẫn kẹt thì kho vẫn không quét được.
  const zone = new QrZone(2, 1500);
  const frame = [
    qr("https://m.tiktok.shop/s/ALIfL0VLNKnL", 40),
    qr("TTVN1111790805", 40),
  ];
  const t0 = new Date("2026-09-25T10:00:00Z");
  const first = zone.ingest(frame, t0);
  assert.equal(first.warning, undefined, "không được cảnh báo hai nhãn");
  const second = zone.ingest(frame, new Date(t0.getTime() + 200));
  assert.equal(second.emission?.text, "TTVN1111790805");
});
