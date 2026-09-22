import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NAV_ACCESS, canSeeHref, firstAllowedHref, navHrefForPath } from "../src/lib/nav-access.ts";
import { resolveStationLiveScope } from "../src/lib/live/station-streams.ts";

/**
 * Phân lại quyền (chủ dự án chốt 21/09/2026):
 *   Admin full · Trưởng kho full trừ setup camera · Viewer chỉ xem và tải video.
 *
 * Ma trận thật nằm trên database; các test dưới đọc đúng hai tập mã trong
 * migration để kiểm giao diện và API theo cùng một nguồn.
 */

const MIGRATION = readFileSync(
  "supabase/migrations/20260921160000_role_permission_redesign.sql",
  "utf8",
);

function sqlArray(name: string): string[] {
  const m = MIGRATION.match(new RegExp(`${name} text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `không thấy ${name} trong migration`);
  return [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
}

const SETUP = sqlArray("v_setup");
const VIEWER = sqlArray("v_viewer");

// Mọi mã quyền đang có (ảnh chụp production 21/09/2026) + mã mới.
const ALL = [
  "audit.view", "camera.archive", "camera.create", "camera.recording.control",
  "camera.recording.view", "camera.test", "camera.update", "camera.view",
  "live.view_remote", "live.view_station", "order_proof.generate", "order_proof.view",
  "organization.update", "organization.view", "packing_station.archive",
  "packing_station.camera_setup", "packing_station.create", "packing_station.update",
  "packing_station.view", "report.view", "staff.create", "staff.delete", "staff.invite",
  "staff.qr.regenerate", "staff.update", "staff.view", "station.update",
  "station_device.archive", "station_device.create", "station_device.update",
  "station_device.view", "station_device_assignment.manage",
  "station_device_assignment.view", "user.create", "user.delete", "user.update",
  "user.view", "video.download", "video.view", "warehouse.create", "warehouse.delete",
  "warehouse.update", "warehouse.view", "work_session.force_end", "return.operate",
];

const ADMIN = new Set(ALL);
const MANAGER = new Set(ALL.filter((p) => !SETUP.includes(p)));
const VIEWER_SET = new Set(VIEWER);
const canFor = (set: Set<string>) => (anyOf: string[]) => anyOf.some((p) => set.has(p));
// nav.ts kéo theo icon, không import được dưới react-server — đọc href từ nguồn.
const MENU_HREFS = [...readFileSync("src/lib/nav.ts", "utf8").matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
const visible = (set: Set<string>) => MENU_HREFS.filter((h) => canSeeHref(h, canFor(set)));

test("mọi mục menu đều đã khai quyền, đúng thứ tự menu", () => {
  assert.deepEqual(NAV_ACCESS.map(([h]) => h), MENU_HREFS);
});

test("nhóm setup đúng phạm vi đã chốt: camera, gán vào bàn, thiết bị, máy trạm", () => {
  for (const p of [
    "camera.create", "camera.update", "camera.archive", "camera.test",
    "packing_station.camera_setup", "station_device_assignment.manage",
    "station_device.create", "station_device.update", "station_device.archive",
  ]) {
    assert.ok(SETUP.includes(p), `${p} phải thuộc nhóm setup`);
  }
  // Không lỡ tay rút quyền vận hành của trưởng kho.
  for (const p of ["camera.recording.control", "packing_station.create", "user.create", "order_proof.generate"]) {
    assert.ok(!SETUP.includes(p), `${p} không phải setup camera`);
  }
});

test("viewer: chỉ thấy 4 trang video, có quyền tải, không có quyền ghi nào", () => {
  assert.deepEqual(visible(VIEWER_SET).sort(), [
    "/dashboard/operations",
    "/dashboard/return-videos",
    "/dashboard/returns",
    "/dashboard/videos",
  ]);
  assert.ok(VIEWER_SET.has("video.download"));
  assert.ok(VIEWER_SET.has("live.view_remote"), "xem được camera trực tiếp trên trang giám sát");
  const WRITE = /\.(create|update|delete|archive|manage|generate|invite|control|test|operate|regenerate|force_end|camera_setup)$/;
  assert.deepEqual(VIEWER.filter((p) => WRITE.test(p)), []);
});

test("viewer vào trang chủ được đưa tới trang video đầu tiên", () => {
  const can = canFor(VIEWER_SET);
  assert.equal(canSeeHref(navHrefForPath("/dashboard")!, can), false);
  assert.equal(firstAllowedHref(can), "/dashboard/operations");
  assert.equal(canSeeHref(navHrefForPath("/dashboard/devices")!, can), false);
  assert.equal(canSeeHref(navHrefForPath("/dashboard/users")!, can), false);
});

test("trưởng kho: mọi trang trừ Máy trạm kho; Thiết bị kho chỉ xem", () => {
  assert.deepEqual(
    MENU_HREFS.filter((h) => !visible(MANAGER).includes(h)).sort(),
    ["/dashboard/agents"],
  );
  assert.ok(!visible(VIEWER_SET).includes("/dashboard/devices"), "viewer không thấy Thiết bị kho");
});

test("Thiết bị kho: mỗi thao tác chỉ hiện khi có đúng quyền (trưởng kho chỉ xem)", () => {
  const src = readFileSync("src/app/dashboard/devices/page.tsx", "utf8");
  for (const needle of [
    "{allow.add && (",          // Thêm thiết bị
    "readOnly={!allow.assign}", // đổi bàn ngay trong bảng
    "{allow.edit && (",         // Chỉnh sửa
    "{allow.assign && (",       // Gán / Đổi bàn trong menu
    "{showDelete && onDelete && (",
  ]) {
    assert.ok(src.includes(needle), `thiếu chốt ẩn: ${needle}`);
  }
  const can = (p: string) => MANAGER.has(p);
  // Trưởng kho: không có quyền nào trong các nhóm thao tác của trang.
  for (const p of ["camera.create", "station_device.create", "station_device_assignment.manage",
    "station_device.update", "camera.update", "camera.archive", "station_device.archive", "camera.test"]) {
    assert.equal(can(p), false, `trưởng kho không được có ${p}`);
  }
  assert.ok(MANAGER.has("station_device.view"), "trưởng kho vẫn xem được thiết bị");
});

test("admin thấy mọi trang", () => {
  assert.equal(visible(ADMIN).length, MENU_HREFS.length);
});

test("trang con khớp mục menu dài nhất (cấm cả đường dẫn con)", () => {
  assert.equal(navHrefForPath("/dashboard/settings/warehouse-config"), "/dashboard/settings/warehouse-config");
  assert.equal(navHrefForPath("/dashboard/devices/abc"), "/dashboard/devices");
  assert.equal(navHrefForPath("/dashboard/khong-co"), null);
});

test("xem camera trực tiếp theo quyền live.view_remote, không theo tên vai trò", () => {
  const base = { isPlatform: false, requestedStationId: "a", assignedStationId: null };
  assert.equal(resolveStationLiveScope({ ...base, role: "viewer", canViewRemote: true }), "admin");
  assert.equal(resolveStationLiveScope({ ...base, role: "warehouse_manager", canViewRemote: true }), "admin");
  assert.equal(resolveStationLiveScope({ ...base, role: "shift_leader", canViewRemote: false }), "forbidden");
  // Database chưa áp migration: owner/admin vẫn xem được.
  assert.equal(resolveStationLiveScope({ ...base, role: "admin" }), "admin");
});

// ---------------------------------------------------------------------------
// Chốt chặn phía API: mọi thao tác setup phải đòi một mã trong nhóm setup,
// để rút nhóm đó khỏi trưởng kho là chặn hết.
// ---------------------------------------------------------------------------

function writeGuards(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/export async function (POST|PUT|PATCH|DELETE)\b[\s\S]*?require[A-Za-z]*\(\s*"([a-z_.]+)"/g)) {
    out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

test("API setup camera / thiết bị / máy trạm đều đòi quyền nhóm setup", () => {
  const files = [
    "src/app/api/cameras/route.ts",
    "src/app/api/cameras/discover/route.ts",
    "src/app/api/cameras/test-draft/route.ts",
    "src/app/api/cameras/[id]/route.ts",
    "src/app/api/cameras/[id]/test-connection/route.ts",
    "src/app/api/cameras/[id]/probe-codec/route.ts",
    "src/app/api/station-devices/route.ts",
    "src/app/api/station-devices/[id]/route.ts",
    "src/app/api/station-device-assignments/route.ts",
    "src/app/api/packing-stations/[id]/cameras/route.ts",
    "src/app/api/warehouse/agents/route.ts",
    "src/app/api/warehouse/agents/[id]/route.ts",
    "src/app/api/warehouse/agents/[id]/reset-secret/route.ts",
  ];
  for (const f of files) {
    const guards = writeGuards(f);
    assert.ok(guards.length > 0, `${f}: không thấy thao tác ghi`);
    for (const g of guards) {
      const perm = g.split(" ")[1];
      assert.ok(SETUP.includes(perm), `${f} ${g}: phải đòi quyền nhóm setup`);
    }
  }
});

test("mọi vai trò có hai trang video minh chứng (xem + tải)", () => {
  for (const code of ["order_proof.view", "video.view", "video.download"]) {
    assert.ok(VIEWER.includes(code), `viewer thiếu ${code}`);
    assert.ok(MANAGER.has(code) && ADMIN.has(code), `admin/trưởng kho thiếu ${code}`);
    const tail = MIGRATION.slice(MIGRATION.indexOf("ARRAY['shift_leader', 'packer'] LOOP"));
    assert.ok(tail.includes(`'${code}'`), `trưởng ca / nhân viên đóng gói phải được cấp ${code}`);
  }
  for (const href of ["/dashboard/videos", "/dashboard/return-videos"]) {
    assert.ok(canSeeHref(href, canFor(new Set(["order_proof.view"]))), `${href} chỉ cần order_proof.view`);
  }
});

test("vào phân hệ hàng hoàn là tự chuyển nhận hoàn, trừ bàn đã chủ động tắt", () => {
  const src = readFileSync("src/components/returns/ReturnCaptureProvider.tsx", "utf8");
  assert.ok(src.includes('run(ids, "open", true)'), "phải tự bật khi vào phân hệ");
  assert.ok(src.includes("OPT_OUT_KEY"), "phải nhớ bàn người dùng đã tắt (chạy lai)");
  assert.ok(src.includes("auto && res.status === 403"), "Viewer tự bật bị từ chối thì im lặng");
});

test("thao tác hàng hoàn đòi return.operate — viewer chỉ xem", () => {
  assert.deepEqual(writeGuards("src/app/api/returns/capture/route.ts"), ["POST return.operate"]);
  assert.deepEqual(writeGuards("src/app/api/returns/claims/bulk/route.ts"), ["POST return.operate"]);
  assert.ok(!VIEWER.includes("return.operate"));
});
