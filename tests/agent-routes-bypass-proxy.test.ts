import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";

/**
 * Mọi đường của agent phải được khai báo trong `PUBLIC_API_PREFIXES` của
 * `src/lib/supabase/proxy.ts`.
 *
 * Vì sao cần test này: agent xác thực bằng HMAC chứ không có session
 * cookie. Quên khai báo thì proxy chặn ngay vòng ngoài và trả
 * `401 unauthenticated` — request KHÔNG bao giờ tới chỗ kiểm HMAC, nên
 * mọi test gọi thẳng route handler vẫn xanh. Ngày 16/09/2026 lỗi này đã
 * xảy ra thật với `/api/agent/camera-ip-healed`: nghiệm thu gọi thẳng
 * handler báo 10/10 đạt, nhưng chạy đầu-cuối trên agent thật thì cloud
 * từ chối 401 và camera không bao giờ được chữa IP.
 *
 * Đọc bằng regex thay vì import: `proxy.ts` kéo theo `@supabase/ssr` và
 * cả runtime của Next, không nạp được trong test thuần.
 */
test("mọi route của agent đều bypass được proxy phiên đăng nhập", () => {
  const source = readFileSync("src/lib/supabase/proxy.ts", "utf8");
  const block = /const PUBLIC_API_PREFIXES = \[([\s\S]*?)\];/.exec(source);
  assert.ok(block, "không tìm thấy PUBLIC_API_PREFIXES trong proxy.ts");

  const declared = new Set(
    [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  );

  const missing = Object.entries(AGENT_API_PATHS)
    .filter(([, path]) => {
      for (const prefix of declared) {
        if (path === prefix || path.startsWith(prefix + "/")) return false;
      }
      return true;
    })
    .map(([key, path]) => `${key} (${path})`);

  assert.deepEqual(
    missing,
    [],
    `Route agent chưa được khai báo trong PUBLIC_API_PREFIXES — proxy sẽ trả 401 unauthenticated trước khi kiểm HMAC: ${missing.join(", ")}`,
  );
});
