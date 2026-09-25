import type { DecodedQr, QrBox } from "./qr-zone";

/**
 * Chọn MỘT mã trong số các mã nhìn thấy trên khung hình.
 *
 * Chủ dự án chốt 24/09/2026: mã vạch và QR trên nhãn là CÙNG một mã vận
 * đơn, "quét trúng cái nào cũng được", "không cần ưu tiên QR hay barcode".
 * Nên ở đây không có loại nào thắng loại nào.
 *
 * Luật chọn dựa vào một điều nhìn thấy trên chính nhãn thật (ảnh nhãn J&T
 * chủ dự án gửi 24/09/2026): mã vận đơn được in LẶP LẠI — một mã vạch to
 * ngang, một QR, hai mã vạch dọc, tất cả cùng `854160978771`. Còn mã phân
 * loại / mã tuyến chỉ xuất hiện đúng một lần. Vậy:
 *
 *   0. Đường link thì bỏ, bất kể QR hay mã vạch. Nhãn TikTok in hai mã QR
 *      cạnh nhau — một mã vận đơn, một link tới trang shop — và camera bắt
 *      trúng cái nào trước thì gửi cái đó (chủ dự án chốt 25/09/2026: "bắt
 *      được QR link thì bỏ qua, chỉ nhận QR mã vận đơn").
 *   1. Mã vạch phải "trông giống mã vận đơn" mới được xét. Nhận nhầm mã
 *      tuyến kiểu "HN01" là tạo ra đơn KHÔNG có thật, và cái sai đó chỉ lộ
 *      ra lúc đối soát. QR thì không lọc: trước giờ agent chỉ đọc QR và
 *      đường đó đang chạy tốt, thêm bộ lọc vào là tự chặn chính mình.
 *   2. Nội dung nào xuất hiện NHIỀU LẦN trong khung thì thắng — đó là mã
 *      vận đơn. Hoà số lần thì lấy mã to nhất.
 *   3. Chỉ khi hai nội dung khác nhau mà số lần BẰNG nhau và to xấp xỉ
 *      nhau thì mới không đoán: đó là dấu hiệu hai nhãn cùng trong khung,
 *      đoán sai là quét nhầm kiện.
 */

/** Mã vạch phải to hơn mã kế tiếp bấy nhiêu lần mới được coi là mã chính. */
const DOMINANT_RATIO = 1.5;

/** Ngắn hơn ngần này thì không phải mã vận đơn. */
const MIN_WAYBILL_LENGTH = 8;
const MAX_WAYBILL_LENGTH = 40;

function area(box: QrBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/**
 * Chuỗi này có dáng một mã vận đơn không?
 *
 * Cố tình dễ tính: các sàn đặt mã rất khác nhau (SPXVN062557638709,
 * 260923Q5MYXBJT, TTVN1099351268, 862491521365). Chỉ chặn những thứ rõ
 * ràng KHÔNG phải: quá ngắn, quá dài, có dấu cách, hoặc không có lấy một
 * chữ số nào.
 */
export function looksLikeWaybill(text: string): boolean {
  const value = text.trim();
  if (value.length < MIN_WAYBILL_LENGTH || value.length > MAX_WAYBILL_LENGTH) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(value)) return false;
  const digits = (value.match(/\d/g) ?? []).length;
  return digits >= 6;
}

/**
 * Chuỗi này là một đường link?
 *
 * Nhãn TikTok in HAI mã QR cạnh nhau: mã vận đơn và một mã link tới trang
 * shop (`https://m.tiktok.shop/s/ALIfL0VLNKnL`). Camera bắt trúng cái nào
 * trước thì gửi cái đó lên, mã vận đơn ngay bên cạnh bị bỏ qua — sự cố
 * kho Đại Kim 25/09/2026. Tệ hơn: hai mã ngang cơ trong cùng khung còn
 * rơi vào nhánh "hai nhãn cùng lúc" và không gửi gì cả.
 *
 * Luật để CHẶT, chỉ bắt thứ chắc chắn là link: có `://`, mở đầu bằng
 * `www.`, hoặc là tên miền có đuôi phổ biến. Cố tình KHÔNG dùng
 * `looksLikeWaybill` cho QR — các sàn đặt mã rất khác nhau, lọc rộng ở
 * đây là tự chặn chính mình (xem ghi chú đầu file).
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_HEAD = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?]|$)/i;
/** Đuôi tên miền hay gặp trên nhãn của các sàn bán hàng. */
const LINK_TLDS = new Set([
  "com", "vn", "shop", "net", "org", "co", "io", "me",
  "link", "app", "cn", "id", "ph", "my", "th", "sg",
]);

export function looksLikeLink(text: string): boolean {
  const value = text.trim();
  if (SCHEME.test(value)) return true;
  if (/^www\./i.test(value)) return true;
  const host = HOST_HEAD.exec(value)?.[1];
  if (!host) return false;
  return LINK_TLDS.has(host.slice(host.lastIndexOf(".") + 1).toLowerCase());
}

export interface CodeCandidate extends DecodedQr {
  /**
   * `qr` gồm cả QR và DataMatrix; `barcode` là mã vạch một chiều.
   *
   * Để trống thì coi như QR: trước 24/09/2026 agent chỉ đọc QR nên mọi
   * bản ghi cũ và mọi bộ giải mã giả trong test đều là QR.
   */
  kind?: "qr" | "barcode";
}

export interface PickResult {
  picked?: DecodedQr;
  /** Nhiều mã ngang cơ trong khung — nhiều khả năng hai nhãn cùng lúc. */
  ambiguous?: boolean;
}

interface Seen {
  text: string;
  /** Số lần nội dung này xuất hiện trong khung — in lặp lại thì cao. */
  count: number;
  /** Khung to nhất trong các lần xuất hiện, dùng cho ảnh bằng chứng. */
  box: QrBox;
}

/** Mã này có đáng đem ra xét làm mã vận đơn không? */
function worthConsidering(candidate: CodeCandidate, text: string): boolean {
  // QR link trên nhãn TikTok: bỏ hẳn, để mã vận đơn in ngay cạnh được
  // chọn, thay vì tranh nhau rồi hoá "hai nhãn trong khung".
  if (looksLikeLink(text)) return false;
  // Mã vạch phải có dáng mã vận đơn; QR nhận nguyên như trước.
  return (candidate.kind ?? "qr") !== "barcode" || looksLikeWaybill(text);
}

export function pickScanCode(candidates: CodeCandidate[]): PickResult {
  const byText = new Map<string, Seen>();
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (!text || !worthConsidering(candidate, text)) continue;
    const prior = byText.get(text);
    if (!prior) {
      byText.set(text, { text, count: 1, box: candidate.box });
      continue;
    }
    prior.count += 1;
    if (area(candidate.box) > area(prior.box)) prior.box = candidate.box;
  }

  const seen = [...byText.values()].sort(
    (a, b) => b.count - a.count || area(b.box) - area(a.box),
  );
  if (seen.length === 0) return {};
  if (seen.length === 1) return { picked: { text: seen[0].text, box: seen[0].box } };

  const [first, second] = seen;
  const sameCount = first.count === second.count;
  const sameSize = area(first.box) < area(second.box) * DOMINANT_RATIO;
  if (sameCount && sameSize) return { ambiguous: true };
  return { picked: { text: first.text, box: first.box } };
}
