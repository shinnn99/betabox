/**
 * Chuẩn hoá MAC về `AA:BB:CC:DD:EE:FF`.
 *
 * BẢN SAO của `normalizeMac` trong `warehouse-agent/src/lan-arp.ts` — hai
 * bên phải cho ra cùng một chuỗi, nếu không thì MAC agent báo lên sẽ không
 * khớp MAC cloud đã lưu và tính năng tự phục hồi IP đứng im. Sửa một bên
 * thì sửa cả bên kia, và cả hai đều phải khớp CHECK constraint
 * `cameras_mac_address_format_check`.
 *
 * Trả null khi: rỗng, sai độ dài, toàn 0 (entry rác trong bảng ARP), hoặc
 * broadcast. Null nghĩa là "không biết MAC" — hợp lệ, không phải lỗi.
 */
export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return null;
  if (hex === "000000000000" || hex === "FFFFFFFFFFFF") return null;
  return hex.match(/.{2}/g)!.join(":");
}

/** True khi chuỗi đã đúng dạng chuẩn hoá. Dùng để guard trước khi ghi DB. */
export function isNormalizedMac(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(value);
}
