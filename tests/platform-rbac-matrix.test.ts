import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERMISSION_DEFINITIONS, RBAC_ROLES } from "../src/lib/rbac-catalog.ts";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("danh mục RBAC không trùng mã và giữ đủ sáu vai trò đang có dữ liệu", () => {
  assert.equal(new Set(PERMISSION_DEFINITIONS.map((permission) => permission.code)).size, PERMISSION_DEFINITIONS.length);
  assert.deepEqual(RBAC_ROLES.map((role) => role.code), [
    "owner",
    "admin",
    "warehouse_manager",
    "shift_leader",
    "packer",
    "viewer",
  ]);
  assert.deepEqual(
    RBAC_ROLES.filter((role) => role.lockedFullAccess).map((role) => role.code),
    ["owner", "admin"],
  );
});

test("Bảng điều khiển có quyền riêng, không còn mượn quyền Báo cáo", () => {
  assert.ok(read("src/lib/nav-access.ts").includes('["/dashboard", ["dashboard.view"]]'));
  for (const path of [
    "src/app/api/dashboard/overview/route.ts",
    "src/app/api/dashboard/production/route.ts",
  ]) {
    assert.ok(read(path).includes('requirePermission("dashboard.view")'));
  }
  assert.ok(read("src/app/api/reports/performance/route.ts").includes('requirePermission("report.view")'));
});

test("API ma trận: support chỉ đọc, owner mới ghi, owner/admin luôn full", () => {
  const api = read("src/app/api/platform/permissions/route.ts");
  assert.ok(api.includes('requirePlatformRole("platform_support")'));
  assert.ok(api.includes('requirePlatformRole("platform_owner")'));
  assert.ok(api.includes("role.lockedFullAccess"));
  assert.ok(api.includes('admin.rpc("replace_role_permission_matrix"'));
  assert.ok(api.includes("unknown_permission"));
  assert.ok(api.includes("unknown_role"));
});

test("ngữ cảnh phiên không phụ thuộc một quyền có thể bị Platform thu hồi", () => {
  const route = read("src/app/api/session-context/route.ts");
  assert.ok(route.includes("requireOrganizationContext(req)"));
  assert.ok(!route.includes('requirePermission("warehouse.view")'));
  assert.ok(!route.includes('requirePermission("staff.view")'));
});

test("migration thay ma trận và audit trong cùng transaction, RPC chỉ service_role", () => {
  const sql = read("supabase/migrations/20260930160000_platform_rbac_matrix.sql");
  assert.ok(sql.includes("CREATE OR REPLACE FUNCTION public.replace_role_permission_matrix"));
  assert.ok(sql.includes("DELETE FROM public.role_permission_matrix"));
  assert.ok(sql.includes("INSERT INTO public.platform_audit_log"));
  assert.ok(sql.includes("'platform.rbac.update'"));
  assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.replace_role_permission_matrix"));
  assert.ok(sql.includes("TO service_role"));
  assert.ok(sql.includes("REVOKE ALL ON FUNCTION public.replace_role_permission_matrix"));
});

test("trang ma trận dùng table semantic, checkbox native và header/cột sticky", () => {
  const page = read("src/app/platform/permissions/page.tsx");
  assert.ok(page.includes("<table"));
  assert.ok(page.includes("<caption"));
  assert.ok(page.includes('scope="col"'));
  assert.ok(page.includes('scope="row"'));
  assert.ok(page.includes('type="checkbox"'));
  assert.ok(page.includes("sticky top-0"));
  assert.ok(page.includes("sticky left-0"));
  assert.ok(read("src/lib/platform-nav.ts").includes('href: "/platform/permissions"'));
});

test("trưởng kho xoá tài khoản thấp hơn vẫn bị chặn leo thang và chủ cuối", () => {
  const api = read("src/app/api/users/[id]/route.ts");
  const body = api.slice(api.indexOf("export async function DELETE("));
  assert.ok(body.includes('requirePermissionStrict("user.delete", req)'));
  assert.ok(body.includes("canAssignRole(ctx.role, target.role as Role)"));
  assert.ok(body.includes("self_delete_forbidden"));
  assert.ok(body.includes("last_owner"));
  assert.ok(!body.includes('ctx.role !== "owner"'));
});
