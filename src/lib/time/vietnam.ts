// Định dạng / bóc tách thời gian theo giờ Việt Nam (Asia/Ho_Chi_Minh).
//
// TẠI SAO CẦN MODULE NÀY: `Date.prototype.getHours()` và
// `toLocaleString("vi-VN")` trả theo TZ CỦA PROCESS. Trên trình duyệt nhân viên
// kho thì đúng (máy để giờ VN), nhưng trên Vercel thì TZ = UTC → mọi giờ hiển
// thị và mọi bucket-theo-giờ tính ở server đều lệch -7. Đường nào chạy server
// (card Lark, KPI theo giờ) PHẢI đi qua đây.
//
// Dùng offset cố định +7 thay vì Intl: VN không có DST, và cách này khớp
// precedent sẵn có ở lib/warehouse/time-range.ts, đồng thời không phụ thuộc
// ICU data của runtime.
//
// Module THUẦN — không "server-only", để dùng được cả hai phía và test được.

export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface VnParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

function toDate(input: string | number | Date): Date | null {
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Bóc các thành phần lịch theo giờ VN. Trả null nếu input không parse được
 * (caller quyết định fallback — không throw ở đường hot path).
 */
export function vnParts(input: string | number | Date): VnParts | null {
  const d = toDate(input);
  if (!d) return null;
  // Dịch instant sang "đồng hồ VN" rồi đọc bằng getUTC* — không đụng TZ process.
  const shifted = new Date(d.getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Giờ 0-23 theo VN. Null nếu input không parse được. */
export function vnHour(input: string | number | Date): number | null {
  return vnParts(input)?.hour ?? null;
}

const pad = (n: number) => n.toString().padStart(2, "0");

/**
 * "HH:mm:ss" giờ VN. Input hỏng → trả nguyên input (giữ hành vi cũ của
 * formatTime trong lark/messages.ts: thà hiện chuỗi thô còn hơn "NaN:NaN").
 */
export function formatVnTime(iso: string): string {
  const p = vnParts(iso);
  if (!p) return iso;
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** "dd/MM/yyyy HH:mm:ss" giờ VN. Input hỏng → trả nguyên input. */
export function formatVnDateTime(input: string | number | Date): string {
  const p = vnParts(input);
  if (!p) return typeof input === "string" ? input : String(input);
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
