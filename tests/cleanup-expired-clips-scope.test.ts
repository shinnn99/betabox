import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Phạm vi org của cleanupExpiredClips.
 *
 * Lỗ đã có thật (12/08/2026): route /api/admin/cleanup-expired-clips cho
 * vào bằng `profile.role === 'admin'` — admin của MỘT org bất kỳ, không
 * phải platform admin — rồi gọi cleanupExpiredClips() không tham số, mà
 * hàm đó query order_proof_clips KHÔNG có filter organization_id. Kết
 * quả: admin khách A bấm nút là xoá clip khỏi bucket + set 'evicted' cho
 * clip của MỌI khách.
 *
 * Verify HAI NỬA:
 *   - dương: truyền org → PHẢI có .eq("organization_id", org) ở fetch.
 *   - âm: không truyền → KHÔNG được tự ý thêm filter (đường cron toàn hệ
 *     vẫn phải dọn được cả hệ, nếu không cron chỉ dọn được một org).
 */

interface Calls {
  tables: string[];
  eqs: Array<[string, unknown]>;
}

/**
 * Admin client giả: mọi bước chain trả về chính nó và bản thân nó
 * thenable, nên `await query` ra {data: [], error: null} → hàm dừng sớm
 * ở nhánh "không có row nào quá hạn". Đủ để soi filter mà không cần
 * giả lập storage.
 */
function fakeAdmin(calls: Calls) {
  const q: Record<string, unknown> = {
    select: () => q,
    not: () => q,
    lt: () => q,
    in: () => q,
    update: () => q,
    eq: (col: string, val: unknown) => {
      calls.eqs.push([col, val]);
      return q;
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  };
  return {
    from: (t: string) => {
      calls.tables.push(t);
      return q;
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
}

const ORG = "e3cb7cd1-e869-4d55-936d-5bcb1a1467b8";

async function runWith(options: { organizationId?: string } | undefined) {
  const calls: Calls = { tables: [], eqs: [] };
  const { cleanupExpiredClips } = await import("../src/lib/watch/cleanup.ts");
  const result = await cleanupExpiredClips({
    ...(options ?? {}),
    client: fakeAdmin(calls) as never,
  });
  return { calls, result };
}

test("nửa dương: có organizationId → fetch lọc theo org", async () => {
  const { calls, result } = await runWith({ organizationId: ORG });
  assert.equal(result.ok, true);
  assert.ok(
    calls.eqs.some(([col, val]) => col === "organization_id" && val === ORG),
    `phải có .eq("organization_id", org); thực tế: ${JSON.stringify(calls.eqs)}`,
  );
});

test("nửa âm: không truyền org → KHÔNG tự thêm filter (đường cron toàn hệ)", async () => {
  const { calls, result } = await runWith(undefined);
  assert.equal(result.ok, true);
  assert.equal(
    calls.eqs.filter(([col]) => col === "organization_id").length,
    0,
    "cron secret phải dọn được toàn hệ, không bị bó vào một org",
  );
});
