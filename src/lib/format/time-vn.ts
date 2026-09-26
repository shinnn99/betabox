/**
 * Định dạng giờ cho các trang platform — dùng chung để mọi ô trên trang
 * Tình trạng hiển thị giờ y hệt nhau. Tách khỏi
 * src/app/platform/system/page.tsx ngày 26/09/2026 khi thêm ô Sổ sự cố.
 *
 * Hàm thuần, không đụng DB — dùng được ở cả client lẫn server.
 */

export function formatVn(iso: string | null): string {
  if (!iso) return "chưa có";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "chưa có";
  return d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}

/** "3 phút trước" — cho biết mốc còn tươi hay đã cũ mà không phải trừ tay. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

/** "3 giờ 15 phút" — khoảng giữa hai mốc, cho cột "kéo dài" của trang Sự cố. */
export function spanLabel(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  if (mins < 60) return `${mins} phút`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} giờ ${mins % 60} phút`;
  return `${Math.floor(hours / 24)} ngày ${hours % 24} giờ`;
}
