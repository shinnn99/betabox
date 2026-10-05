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

// ---------------------------------------------------------------------------
// Bảng chức năng chủ dự án chốt 30/09/2026 (ảnh "CHỨC NĂNG × VAI TRÒ").
// Mỗi dòng = một trang menu; vai trò có "CÓ" phải thấy trang, còn lại không.
// ---------------------------------------------------------------------------

function finalSqlArray(name: string): Set<string> {
  const sql = read("supabase/migrations/20260930160000_platform_rbac_matrix.sql");
  const m = sql.match(new RegExp(`${name} text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `không thấy ${name}`);
  return new Set([...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]));
}

const SPEC_ROLES = {
  warehouse_manager: finalSqlArray("v_manager"),
  packer: finalSqlArray("v_packer"),
  viewer: finalSqlArray("v_viewer"),
} as const;

type SpecRole = keyof typeof SPEC_ROLES;
const M = "warehouse_manager", P = "packer", V = "viewer";
const SPEC: ReadonlyArray<readonly [string, string, readonly SpecRole[]]> = [
  ["Bảng điều khiển", "/dashboard", [M, P, V]],
  ["Giám sát đóng hàng", "/dashboard/operations", [M, P, V]],
  ["Bằng chứng giao hàng", "/dashboard/videos", [M, P, V]],
  ["Giám sát hoàn hàng", "/dashboard/returns", [M, P, V]],
  ["Bằng chứng hoàn hàng", "/dashboard/return-videos", [M, P, V]],
  ["Tổ chức & Kho", "/dashboard/warehouses", [M]],
  ["Bàn đóng hàng", "/dashboard/packing-stations", [M]],
  ["Thiết bị kho", "/dashboard/devices", [M]],
  ["Máy trạm kho", "/dashboard/agents", [M]],
  // Dung lượng lưu trữ (02/10/2026): cùng quyền station_device.view với Máy
  // trạm kho, nên cùng một cột — Trưởng kho vào được, Đóng gói và Quan sát
  // viên không.
  ["Dung lượng lưu trữ", "/dashboard/storage", [M]],
  ["Nhân sự kho", "/dashboard/staff", [M]],
  ["Báo cáo hiệu suất", "/dashboard/reports", [M]],
  ["Người dùng hệ thống", "/dashboard/users", [M]],
  ["Cấu hình kho", "/dashboard/settings/warehouse-config", []],
];

test("bảng chức năng 30/09: từng trang đúng vai trò được vào", async () => {
  const { canSeeHref, NAV_ACCESS } = await import("../src/lib/nav-access.ts");
  // Bảng chốt phủ đủ menu: thêm trang mới mà quên xếp quyền thì test đỏ.
  assert.deepEqual(SPEC.map(([, href]) => href).sort(), NAV_ACCESS.map(([href]) => href).sort());
  for (const [label, href, allowed] of SPEC) {
    for (const role of Object.keys(SPEC_ROLES) as SpecRole[]) {
      const grants = SPEC_ROLES[role];
      const can = (anyOf: string[]) => anyOf.some((p) => grants.has(p));
      assert.equal(canSeeHref(href, can), allowed.includes(role), `${label} × ${role}`);
    }
  }
});

test("bảng chức năng 30/09: chỉ-xem đúng nghĩa, mọi vai trò xem + tải video", () => {
  const WRITE = /\.(create|update|delete|archive|manage|generate|invite|control|test|operate|regenerate|force_end|camera_setup)$/;
  for (const [role, grants] of Object.entries(SPEC_ROLES)) {
    assert.ok(grants.has("video.view") && grants.has("video.download"), `${role} phải xem + tải video`);
    assert.ok(!grants.has("sensitive.view"), `${role} không xem thông tin nhạy cảm`);
    const writes = [...grants].filter((p) => WRITE.test(p));
    // Trưởng kho: ngoại lệ duy nhất là CRUD người dùng vai trò thấp hơn.
    const expected = role === "warehouse_manager" ? ["user.create", "user.delete", "user.update"] : [];
    assert.deepEqual(writes.sort(), expected, `${role} có quyền ghi ngoài bảng chốt`);
  }
  // Nhân viên đóng gói chỉ xem trực tiếp tại bàn phụ trách, không xem mọi bàn.
  assert.ok(SPEC_ROLES.packer.has("live.view_station"));
  assert.ok(!SPEC_ROLES.packer.has("live.view_remote"));
});

test("mọi mã quyền trong migration đều có nhãn tiếng Việt trên trang Platform", () => {
  const codes = new Set(PERMISSION_DEFINITIONS.map((permission) => permission.code));
  for (const grants of Object.values(SPEC_ROLES)) {
    for (const code of grants) assert.ok(codes.has(code), `thiếu nhãn cho ${code}`);
  }
  // Hai mã cũ còn trong database + mã ca làm không được rơi về "Quyền khác".
  for (const code of ["audit.view", "station.update", "work_session.force_end"]) {
    assert.ok(codes.has(code), `thiếu nhãn cho ${code}`);
  }
});

// ---------------------------------------------------------------------------
// Chốt phía API cho các vai trò chỉ-xem (rà soát 30/09/2026).
// ---------------------------------------------------------------------------

test("xem trực tiếp: phạm vi bàn đi theo quyền live.view_station, không theo tên vai trò", async () => {
  const { resolveStationLiveScope } = await import("../src/lib/live/station-streams.ts");
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const base = { isPlatform: false, requestedStationId: A };
  // Platform cấp live.view_station cho Trưởng ca → xem đúng bàn được gán.
  assert.equal(resolveStationLiveScope({ ...base, role: "shift_leader", assignedStationId: A, canViewStation: true }), "station");
  // Platform thu live.view_station của Nhân viên đóng gói → mất hình, kể cả bàn mình.
  assert.equal(resolveStationLiveScope({ ...base, role: "packer", assignedStationId: A, canViewStation: false }), "forbidden");
  assert.equal(resolveStationLiveScope({ ...base, role: "packer", assignedStationId: B, canViewStation: true }), "forbidden");
  // Chưa gán bàn không bao giờ khớp.
  assert.equal(resolveStationLiveScope({ ...base, role: "packer", assignedStationId: null, canViewStation: true }), "forbidden");

  const access = read("src/lib/live/station-access.ts");
  assert.ok(access.includes('roleHasPermission(ctx.role, "live.view_station")'));
  assert.ok(!access.includes('ctx.role === "packer"'), "không khoá cứng theo tên vai trò");
  // Route lấy luồng dùng chung một chốt với luồng sự kiện, không chép logic.
  const route = read("src/app/api/live/[stationId]/route.ts");
  assert.ok(route.includes("requireStationLiveAccess(stationId)"));
  assert.ok(!route.includes("resolveStationLiveScope("));
});

test("gán bàn phụ trách: API kiểm bàn cùng tổ chức, trang Người dùng có ô chọn", () => {
  const helper = read("src/lib/users/station-assignment.ts");
  assert.ok(helper.includes('.eq("organization_id", organizationId)'));
  assert.ok(helper.includes('.eq("status", "active")'));
  const create = read("src/app/api/users/route.ts");
  assert.ok(create.includes("parseStationAssignment(admin, ctx.organizationId, body)"));
  assert.ok(create.includes("listAssignableStations(admin, ctx.organizationId)"));
  const patch = read("src/app/api/users/[id]/route.ts");
  const patchBody = patch.slice(patch.indexOf("export async function PATCH("), patch.indexOf("export async function DELETE("));
  // Gán bàn đi SAU chốt chống leo thang: Trưởng kho chỉ gán được cho vai trò thấp hơn.
  assert.ok(patchBody.indexOf("canAssignRole(ctx.role, target.role as Role)") < patchBody.indexOf("parseStationAssignment("));
  const page = read("src/app/dashboard/users/page.tsx");
  assert.ok(page.includes('label="Bàn phụ trách"'));
  assert.ok(page.includes("STATION_SCOPED_ROLES"));
});

test("cắt lại clip: xem được thì cắt/thử lại được, 'Tạo lại' clip đang có cần order_proof.generate", () => {
  const route = read("src/app/api/order-proof/[pe_id]/watch/retry/route.ts");
  assert.ok(route.includes('requirePermissionStrict("order_proof.view", req)'), "route phải qua guard chuẩn");
  assert.ok(route.includes('.eq("organization_id", auth.organizationId)'), "đơn phải thuộc đúng tổ chức");
  assert.ok(route.includes('roleHasPermission(auth.role, "order_proof.generate")'));
  assert.ok(route.includes("clipBucketValid("));
  for (const path of ["src/app/dashboard/videos/page.tsx", "src/app/dashboard/(return-module)/return-videos/page.tsx"]) {
    const page = read(path);
    assert.ok(page.includes('const canRegenerate = useCan()("order_proof.generate");'), path);
    assert.ok(page.includes("{canRegenerate && ("), path);
  }
});

test("sửa hồ sơ khiếu nại hoàn là thao tác ghi — cùng quyền return.operate với route bulk", () => {
  const route = read("src/app/api/returns/claims/[claimId]/route.ts");
  assert.ok(route.includes('requirePermissionStrict("return.operate", req)'));
  assert.ok(!route.includes('requirePermissionStrict("order_proof.view"'));
  for (const grants of Object.values(SPEC_ROLES)) assert.ok(!grants.has("return.operate"));
});

test("Bảng điều khiển không dẫn tới trang vai trò không vào được", () => {
  const page = read("src/app/dashboard/page.tsx");
  assert.ok(page.includes('canSeeHref("/dashboard/devices", can)'));
  assert.ok(page.includes('canSeeHref("/dashboard/staff", can)'));
  assert.ok(page.includes("{canSeeDevices && ("));
  assert.ok(page.includes("{canSeeStaff && ("));
});

test("quét tay: mọi vai trò trừ Quan sát viên, bằng quyền riêng packing.manual_scan", () => {
  const sql = read("supabase/migrations/20260930170000_manual_scan_permission.sql");
  const granted = [...sql.matchAll(/\('([a-z_]+)', 'packing\.manual_scan'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(granted, ["admin", "owner", "packer", "shift_leader", "warehouse_manager"]);
  assert.ok(!sql.includes("DELETE"), "chỉ thêm dòng, chạy lại vô hại");

  const route = read("src/app/api/warehouse/manual-scan/route.ts");
  assert.ok(route.includes('requirePermission("packing.manual_scan", req)'), "POST ghi lượt quét");
  assert.ok(route.includes('requirePermission("packing.manual_scan");'), "GET danh sách máy quét");
  assert.ok(!route.includes('"station_device.view"'), "không mượn quyền xem thiết bị để ghi");

  // Nhân viên đóng gói không xem được Thiết bị kho / Bàn — trang không được
  // phụ thuộc hai API đó, nếu không sẽ không chọn được máy quét.
  const page = read("src/app/dashboard/packing/scan/page.tsx");
  assert.ok(!page.includes("/api/station-devices"));
  assert.ok(!page.includes("/api/packing-stations"));
  assert.ok(page.includes('fetch("/api/warehouse/manual-scan"'));
  assert.ok(PERMISSION_DEFINITIONS.some((p) => p.code === "packing.manual_scan"));
});

test("xem + tải video luôn bật cho mọi vai trò, Platform không tắt được", () => {
  const alwaysOn = PERMISSION_DEFINITIONS.filter((p) => p.alwaysOn).map((p) => p.code).sort();
  assert.deepEqual(alwaysOn, ["video.download", "video.view"]);
  const api = read("src/app/api/platform/permissions/route.ts");
  assert.ok(api.includes("...ALWAYS_ON_PERMISSION_CODES"), "API ép quyền luôn-bật khi lưu");
  const page = read("src/app/platform/permissions/page.tsx");
  assert.ok(page.includes("alwaysOn.has(permission)"), "ô đơn không bấm được");
  assert.ok(page.includes("if (permission.alwaysOn) continue;"), "bật/tắt cả nhóm bỏ qua quyền luôn-bật");
});
