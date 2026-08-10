import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretPlatformAdminResult } from "../src/lib/platform/admin-check.ts";

/**
 * "Không xác định được" KHÔNG phải "không phải platform admin".
 *
 * Chạy: pnpm test
 *
 * Sự cố 10/08/2026: SUPABASE_SERVICE_ROLE_KEY trên deployment mới bị Supabase
 * từ chối (401). Code kiểm platform viết `const { data } = await ...` — bỏ rơi
 * `error`. supabase-js KHÔNG throw khi 401/5xx, nó trả `{ data: null, error }`,
 * nên `catch` không bao giờ chạy và không có dòng log nào. Kết quả: mọi lượt
 * kiểm đều ra "không phải platform admin", platform owner bị đẩy vào dashboard
 * tenant kèm banner "User chưa được gán organization" — đọc như tài khoản
 * hỏng, trong khi thứ hỏng là hạ tầng. Mất nhiều giờ chẩn nhầm.
 *
 * Hai vế phải giữ cùng lúc, đó là lý do có file này:
 *   - data rỗng + không lỗi  → not_platform (từ chối đúng, fail-closed)
 *   - có lỗi                 → unavailable  (KHÔNG được rơi vào not_platform)
 */

test("có hàng, role hợp lệ → platform", () => {
  assert.deepEqual(interpretPlatformAdminResult({ role: "platform_owner" }, null), {
    kind: "platform",
    platformRole: "platform_owner",
  });
  assert.deepEqual(
    interpretPlatformAdminResult({ role: "platform_support" }, null),
    { kind: "platform", platformRole: "platform_support" },
  );
});

test("không có hàng, không lỗi → not_platform (từ chối đúng)", () => {
  assert.deepEqual(interpretPlatformAdminResult(null, null), {
    kind: "not_platform",
  });
});

test("CÓ LỖI → unavailable, tuyệt đối không phải not_platform", () => {
  const v = interpretPlatformAdminResult(null, {
    code: "PGRST301",
    message: "JWT expired",
  });

  assert.equal(
    v.kind,
    "unavailable",
    "đây chính là ca 10/08: coi lỗi hạ tầng là 'không phải admin' thì định tuyến sai và đổ lỗi cho tài khoản người dùng",
  );
  assert.notEqual(v.kind, "not_platform");
});

test("lỗi 401 service key sai — nguyên văn ca đã cắn", () => {
  const v = interpretPlatformAdminResult(null, {
    code: "401",
    message: "Invalid API key",
  });
  assert.equal(v.kind, "unavailable");
  if (v.kind === "unavailable") {
    // Nguyên nhân phải đi kèm để log chỉ thẳng chỗ hỏng, không bắt người
    // đọc đoán.
    assert.match(v.cause, /401/);
    assert.match(v.cause, /Invalid API key/);
  }
});

test("lỗi VÀ có data → vẫn unavailable, lỗi thắng", () => {
  // Phòng ca driver trả cả hai. Tin vào data lúc đang có lỗi là cấp quyền
  // dựa trên phản hồi không đáng tin.
  const v = interpretPlatformAdminResult(
    { role: "platform_owner" },
    { code: "500", message: "upstream" },
  );
  assert.equal(v.kind, "unavailable");
});

test("role lạ → unavailable, không đoán thành platform admin", () => {
  // Dữ liệu sửa tay hoặc migration lệch. Không nâng quyền theo phỏng đoán,
  // cũng không im lặng bỏ qua như thể tài khoản bình thường.
  const v = interpretPlatformAdminResult({ role: "super_admin" }, null);
  assert.equal(v.kind, "unavailable");
  if (v.kind === "unavailable") assert.match(v.cause, /unknown_role/);
});

test("role null → unavailable", () => {
  assert.equal(
    interpretPlatformAdminResult({ role: null }, null).kind,
    "unavailable",
  );
});
