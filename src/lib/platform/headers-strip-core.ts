// Strip logic thuần cho x-internal-* headers.
// KHÔNG server-only — logic pure trên Web standard Headers interface,
// test được standalone. internal-headers.ts re-export cho proxy import
// (giữ đường import không đổi).
//
// Nhận bất kỳ object có `.headers: Headers` (NextRequest, Request, hoặc
// mock test). Không phụ thuộc Next runtime — vì Headers là WHATWG standard.

import { INTERNAL_PREFIX } from "./internal-headers-core.ts";

/**
 * Xóa mọi header có prefix `x-internal-` KHỎI request in-place.
 * Case-insensitive match: `x-internal-*`, `X-Internal-*`, `X-INTERNAL-*` đều bị strip.
 * Hai-pass (collect keys → delete): mutating during iteration là undefined behavior.
 *
 * WHATWG Headers iterator yield key đã lowercase; nhưng defensive: lowercase
 * lại trong compare để bắt cả biến thể lỡ. Verify Next 16 source: NextRequest
 * extends Request, headers mutable, delete an toàn cho session (cookies không
 * đọc từ x-internal-*).
 */
export function stripInternalHeadersInPlace(request: { headers: Headers }): void {
  const keysToDelete: string[] = [];
  for (const key of request.headers.keys()) {
    if (key.toLowerCase().startsWith(INTERNAL_PREFIX)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    request.headers.delete(key);
  }
}
