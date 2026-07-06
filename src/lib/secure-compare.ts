import { timingSafeEqual } from "node:crypto";

/**
 * HIGH-14: so sánh secret dùng constant-time equality.
 *
 * `a === b` cho JS string dừng ở byte đầu khác nhau → timing khác nhau
 * theo prefix match. Attacker biết endpoint có thể brute-force secret
 * theo byte prefix. Không phải giả tưởng — có nhiều CVE thật.
 *
 * Yêu cầu:
 *   1. Return false ngay nếu 1 input null/empty (không so nếu chưa có config).
 *   2. Convert về Buffer với utf-8 encoding.
 *   3. Nếu length khác → return false thẳng (timingSafeEqual throw khi
 *      length khác — nhưng vẫn expose timing khác cho size; xử lý thủ công
 *      bằng cách so length và HASH thêm 1 buffer dummy để san bằng CPU
 *      cost).
 *   4. Không log secret.
 */

export function secureCompare(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Vẫn chạy timingSafeEqual trên buffer cùng length để tránh timing
    // rõ ràng do so length khác. Không đủ để hide side-channel hoàn hảo
    // nhưng cost khớp constant-time equality trên length min.
    const dummy = Buffer.alloc(a.length);
    try {
      timingSafeEqual(a, dummy);
    } catch {
      // buffer length mismatch trong dummy path — bỏ qua.
    }
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Verify header `Authorization: Bearer <secret>` timing-safe.
 * Trả false cho mọi input không đúng format hoặc không match.
 */
export function verifyBearerSecret(
  authHeader: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!authHeader || !expected) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length);
  return secureCompare(provided, expected);
}
