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

// Đọc migration với line ending đã chuẩn hoá về LF: Windows (core.autocrlf)
// checkout file ra CRLF, làm mọi so khớp chuỗi nhiều dòng dưới đây trượt.
function readSql(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

const MIGRATION = readSql(
  "supabase/migrations/20260921160000_role_permission_redesign.sql",
);

function sqlArray(name: string): string[] {
  const m = MIGRATION.match(new RegExp(`${name} text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `không thấy ${name} trong migration`);
  return [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
}

const SETUP = sqlArray("v_setup");
// Viewer = tập gốc của migration phân quyền + phần thêm sau (Báo cáo, Thiết bị kho).
const VIEWER_EXTRA_SQL = readSql(
  "supabase/migrations/20260922100000_viewer_reports_devices.sql",
);
const VIEWER = [
  ...sqlArray("v_viewer"),
  ...[...VIEWER_EXTRA_SQL.matchAll(/\('viewer', '([a-z_.]+)'\)/g)].map((m) => m[1]),
];

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

test("viewer: xem mọi trang trừ nhóm Quản lý hệ thống; không có quyền ghi nào", () => {
  const MANAGE_SYSTEM = ["/dashboard/users", "/dashboard/settings/warehouse-config", "/dashboard/audit"];
  assert.deepEqual(
    visible(VIEWER_SET).sort(),
    MENU_HREFS.filter((h) => !MANAGE_SYSTEM.includes(h)).sort(),
  );
  for (const h of MANAGE_SYSTEM) {
    assert.ok(!visible(VIEWER_SET).includes(h), `viewer không được thấy ${h}`);
  }
  assert.ok(!VIEWER.includes("sensitive.view"), "viewer không xem thông tin nhạy cảm");
  assert.ok(VIEWER_SET.has("video.download"));
  assert.ok(VIEWER_SET.has("live.view_remote"), "xem được camera trực tiếp trên trang giám sát");
  const WRITE = /\.(create|update|delete|archive|manage|generate|invite|control|test|operate|regenerate|force_end|camera_setup)$/;
  assert.deepEqual(VIEWER.filter((p) => WRITE.test(p)), []);
});

test("trang chủ bị cấm thì đưa tới trang đầu tiên được vào; viewer giờ vào được trang chủ", () => {
  // Viewer có report.view (Báo cáo) nên Bảng điều khiển mở được.
  assert.equal(canSeeHref(navHrefForPath("/dashboard")!, canFor(VIEWER_SET)), true);
  // Tài khoản chỉ có quyền video (không report.view) vẫn được đưa thẳng tới trang video.
  const videoOnly = canFor(new Set(["warehouse.view", "order_proof.view"]));
  assert.equal(canSeeHref(navHrefForPath("/dashboard")!, videoOnly), false);
  assert.equal(firstAllowedHref(videoOnly), "/dashboard/operations");
  assert.equal(canSeeHref(navHrefForPath("/dashboard/users")!, canFor(VIEWER_SET)), false);
});

test("trưởng kho: thấy mọi trang; Thiết bị kho và Máy trạm kho chỉ xem", () => {
  assert.deepEqual(MENU_HREFS.filter((h) => !visible(MANAGER).includes(h)), []);
  assert.ok(!MANAGER.has("station_device.create"), "máy trạm: tạo / cấp secret / xoá bị chặn ở nút");
  // Viewer xem Thiết bị kho nhưng không có quyền setup nào (nút mờ, bấm chỉ báo).
  for (const p of SETUP) assert.ok(!VIEWER.includes(p), `viewer không được có ${p}`);
});

test("Thiết bị kho: mỗi thao tác chỉ hiện khi có đúng quyền (trưởng kho chỉ xem)", () => {
  const src = readFileSync("src/app/dashboard/devices/page.tsx", "utf8");
  for (const needle of [
    'guard(allow.add, "thêm thiết bị"',
    "readOnly={!allow.assign}",
    'guard(allow.edit, "chỉnh sửa thiết bị"',
    'guard(allow.assign, "đổi bàn cho thiết bị"',
    'guard(allow.remove, "xoá thiết bị"',
    'guard(allow.test, "test kết nối camera"',
  ]) {
    assert.ok(src.includes(needle), `thiếu chốt chặn: ${needle}`);
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

test("nhân sự kho: chỉ owner/admin/trưởng kho được ghi, vai trò khác chỉ xem", () => {
  assert.ok(VIEWER.includes("staff.view"));
  assert.deepEqual(VIEWER.filter((p) => p.startsWith("staff.") && p !== "staff.view"), []);
  for (const p of ["staff.create", "staff.update", "staff.delete", "staff.invite", "staff.qr.regenerate"]) {
    assert.ok(MANAGER.has(p), `trưởng kho phải có ${p}`);
  }
  assert.ok(
    MIGRATION.includes("AND permission_code LIKE 'staff.%'\n    AND permission_code <> 'staff.view';"),
    "trưởng ca / nhân viên đóng gói phải bị rút mọi quyền ghi nhân sự",
  );
  const page = readFileSync("src/app/dashboard/staff/page.tsx", "utf8");
  for (const needle of [
    'guard(allow.create, "thêm nhân viên"',
    'guard(allow.update, "sửa nhân viên"',
    'guard(allow.remove, "xoá nhân viên"',
    'guard(allow.link, "liên kết tài khoản web"',
    "canRegenerate={allow.qr}",
    "if (!canRegenerate) {",
  ]) {
    assert.ok(page.includes(needle), `trang Nhân sự thiếu chốt chặn: ${needle}`);
  }
  // Mã QR vào ca chỉ trả cho người được cấp QR — người chỉ xem không lấy được.
  const api = readFileSync("src/app/api/staff/route.ts", "utf8");
  assert.ok(api.includes('roleHasPermission(ctx.role, "staff.qr.regenerate")'));
  assert.ok(api.includes("qr_payload: canSeeQr ?"));
});

test("người dùng hệ thống: chỉ owner/admin/trưởng kho", () => {
  assert.equal(canSeeHref("/dashboard/users", canFor(MANAGER)), true);
  assert.equal(canSeeHref("/dashboard/users", canFor(ADMIN)), true);
  assert.equal(canSeeHref("/dashboard/users", canFor(VIEWER_SET)), false);
  assert.deepEqual(VIEWER.filter((p) => p.startsWith("user.")), []);
  assert.match(
    MIGRATION,
    /DELETE FROM public\.role_permission_matrix\s+WHERE role::text IN \('shift_leader', 'packer'\)\s+AND permission_code LIKE 'user\.%';/,
    "trưởng ca / nhân viên đóng gói phải bị rút mọi quyền user.*",
  );
  // Menu và API cùng một mã: trang và API danh sách đều đòi user.view.
  assert.ok(readFileSync("src/app/api/users/route.ts", "utf8").includes('requirePermission("user.view")'));
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

test("vào phân hệ hàng hoàn KHÔNG tự bật bàn nào — người dùng tự chọn 1, vài hoặc mọi bàn", () => {
  const src = readFileSync("src/components/returns/ReturnCaptureProvider.tsx", "utf8");
  assert.ok(!src.includes('run(ids, "open", true)'), "không được tự bật khi vào phân hệ");
  assert.ok(!src.includes("autoStarted"), "không được tự bật khi vào phân hệ");
  const panel = readFileSync("src/components/returns/ReturnCapturePanel.tsx", "utf8");
  assert.ok(panel.includes("Bắt đầu tất cả bàn"), "vẫn có nút bật mọi bàn");
});

test("thao tác hàng hoàn đòi return.operate — viewer chỉ xem", () => {
  assert.deepEqual(writeGuards("src/app/api/returns/capture/route.ts"), ["POST return.operate"]);
  assert.deepEqual(writeGuards("src/app/api/returns/claims/bulk/route.ts"), ["POST return.operate"]);
  assert.ok(!VIEWER.includes("return.operate"));
});

test("trưởng kho quản lý người dùng vai trò THẤP HƠN, không đụng admin/owner", async () => {
  const { canAssignRole } = await import("../src/lib/auth.ts");
  for (const r of ["shift_leader", "packer", "viewer"] as const) {
    assert.equal(canAssignRole("warehouse_manager", r), true, `trưởng kho phải quản lý được ${r}`);
  }
  for (const r of ["warehouse_manager", "admin", "owner"] as const) {
    assert.equal(canAssignRole("warehouse_manager", r), false, `trưởng kho không được đụng ${r}`);
  }
  for (const p of ["user.view", "user.create", "user.update", "user.delete"]) {
    assert.ok(MANAGER.has(p), `trưởng kho phải có ${p}`);
  }
  // API sửa/xoá chặn theo cấp bậc của tài khoản ĐÍCH, không chỉ vai trò mới.
  const api = readFileSync("src/app/api/users/[id]/route.ts", "utf8");
  assert.equal((api.match(/canAssignRole\(ctx\.role, target\.role as Role\)/g) ?? []).length, 2);
  // Giao diện dùng đúng luật đó: nút + danh sách vai trò lọc theo cấp bậc.
  const page = readFileSync("src/app/dashboard/users/page.tsx", "utf8");
  assert.ok(page.includes("canAssignRole(actorRole, u.role)"));
  assert.ok(page.includes("ROLE_OPTIONS.filter((r) => canAssignRole(actorRole, r.value))"));
  assert.ok(!page.includes("options={ROLE_OPTIONS.map"), "không được liệt kê vai trò cao hơn mình");
});

test("danh sách thiết bị cùng quyền với trang Thiết bị kho (viewer chỉ xem)", () => {
  const src = readFileSync("src/app/api/devices/route.ts", "utf8");
  assert.ok(src.includes('requirePermission("station_device.view")'));
  assert.ok(VIEWER.includes("station_device.view"), "viewer xem được Thiết bị kho");
  // Không tải được danh sách bàn vẫn phải hiện đúng bàn đang gắn.
  const cell = readFileSync("src/components/devices/StationAssignCell.tsx", "utf8");
  assert.ok(cell.includes("!stations.some((s) => s.id === currentStation.station_id)"));
  assert.ok(MANAGER.has("station_device.view"), "trưởng kho vẫn xem được thiết bị");
});

// ---------------------------------------------------------------------------
// Chặn NGAY TỪ NÚT (chủ dự án 22/09/2026): không có quyền thì bấm vào chỉ báo
// "Bạn không có quyền …" — không mở form, không gửi request. Không được để
// người dùng thao tác xong mới nhận "không thành công" từ API.
// ---------------------------------------------------------------------------

test("guard: không có quyền thì báo và KHÔNG chạy thao tác; chưa tải quyền thì bỏ qua", async () => {
  const { runGuarded } = await import("../src/lib/guard-core.ts");
  const said: string[] = [];
  let ran = 0;
  const fn = () => { ran++; };
  assert.equal(runGuarded(true, false, "thêm kho", fn, (m) => said.push(m)), "denied");
  assert.equal(ran, 0, "không có quyền thì tuyệt đối không mở form / gửi request");
  assert.deepEqual(said, ["Bạn không có quyền thêm kho."]);
  assert.equal(runGuarded(false, false, "thêm kho", fn, (m) => said.push(m)), "skipped");
  assert.equal(said.length, 1, "chưa tải xong quyền thì không báo nhầm");
  assert.equal(runGuarded(true, true, "thêm kho", fn, (m) => said.push(m)), "ran");
  assert.equal(ran, 1);
});

test("mọi trang có nút ghi dữ liệu đều chặn từ nút, không ẩn-rồi-để-API-báo-lỗi", () => {
  const PAGES: Array<[string, string[]]> = [
    ["src/app/dashboard/warehouses/page.tsx", ['"sửa thông tin tổ chức"', '"thêm kho"', '"quản lý kho"', '"xoá kho"']],
    ["src/app/dashboard/packing-stations/page.tsx", ['"thêm bàn"', '"sửa bàn"', '"lưu trữ bàn"', "allowed={allow.edit}"]],
    ["src/components/stations/StationPurposeCell.tsx", ["Bạn không có quyền đổi chế độ bàn."]],
    ["src/app/dashboard/settings/warehouse-config/page.tsx", ['"đổi số ngày giữ video"', '"sửa cấu hình kho"', '"test webhook"', '"xoá cấu hình thông báo"']],
    ["src/app/dashboard/devices/page.tsx", ['"thêm thiết bị"', '"xoá thiết bị"']],
    ["src/components/devices/StationAssignCell.tsx", ["Bạn không có quyền đổi bàn cho thiết bị.", "Bạn không có quyền đổi nguồn quét của bàn."]],
    ["src/app/dashboard/staff/page.tsx", ['"thêm nhân viên"', "Bạn không có quyền cấp QR cho nhân viên."]],
    ["src/app/dashboard/users/page.tsx", ["Bạn không có quyền thêm người dùng.", 'tryManage(u, "user.update"', 'tryManage(u, "user.delete"']],
    ["src/app/dashboard/videos/page.tsx", ["Bạn không có quyền đánh dấu lỗi video.", "onClick={g(onMarkError)}"]],
    ["src/app/dashboard/(return-module)/return-videos/page.tsx", ["Bạn không có quyền đổi trạng thái hồ sơ khiếu nại.", "onClick={g(onSubmitted)}"]],
    ["src/components/returns/ReturnCapturePanel.tsx", ["Bạn không có quyền bật/tắt nhận hoàn.", "onClick={g(() => void start([s.id]))}"]],
  ];
  for (const [file, needles] of PAGES) {
    const src = readFileSync(file, "utf8");
    for (const n of needles) assert.ok(src.includes(n), `${file}: thiếu chốt chặn ${n}`);
    // Kiểu cũ: ẩn cả nút/khung theo quyền — người dùng không biết vì sao.
    assert.ok(!/^\s*\{allow\.[a-z]+ && \(/m.test(src), `${file}: còn ẩn nút theo quyền, phải chặn-khi-bấm`);
    assert.ok(!/if \(!can\("[a-z_.]+"\)\) return null;/.test(src), `${file}: còn ẩn cả khung theo quyền`);
  }
});

// ---------------------------------------------------------------------------
// Thông tin có thể bị lợi dụng để tác động tới người khác / hệ thống: API tự
// che với người thiếu quyền (Viewer), không chỉ giấu trên giao diện.
// ---------------------------------------------------------------------------

test("che thông tin nhạy cảm: camera, SĐT, email", async () => {
  const { redactCameraNetwork, maskPhone, maskEmail, HIDDEN } = await import("../src/lib/sensitive-redact.ts");
  const cam = redactCameraNetwork({
    id: "c1", ip: "192.168.1.87", rtsp_port: 554, username: "admin", rtsp_path: "/cam/realmonitor",
    mac_address: "08:ED:ED:9F:DB:97",
    last_test_result: { success: true, message: "rtsp://admin@192.168.1.87:554/cam" },
  });
  assert.equal(cam.ip, HIDDEN);
  assert.equal(cam.username, HIDDEN);
  assert.equal(cam.rtsp_path, HIDDEN);
  assert.equal(cam.rtsp_port, 0);
  assert.equal(cam.mac_address, null);
  assert.deepEqual(cam.last_test_result, { success: true }, "kết quả test cũ chứa URL RTSP");
  assert.equal(cam.id, "c1");
  assert.equal(maskPhone("0912345678"), `09${HIDDEN}678`);
  assert.equal(maskEmail("nguyenvana@gmail.com"), `n${HIDDEN}@gmail.com`);
  assert.equal(maskPhone(null), null);
});

test("API che thông tin nhạy cảm với người thiếu quyền", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  for (const f of ["src/app/api/cameras/route.ts", "src/app/api/devices/route.ts"]) {
    const src = read(f);
    assert.ok(src.includes('roleHasPermission(ctx.role, "sensitive.view")'), `${f}: phải kiểm sensitive.view`);
    assert.ok(src.includes("redactCameraNetwork"), `${f}: phải che IP/RTSP/username/MAC`);
  }
  const staff = read("src/app/api/staff/route.ts");
  assert.ok(staff.includes("maskPhone(s.phone)") && staff.includes("maskEmail(s.email)"));
  for (const f of ["src/app/api/warehouses/route.ts", "src/app/api/warehouses/[id]/route.ts"]) {
    assert.ok(read(f).includes('roleHasPermission(ctx.role, "warehouse.update")'), `${f}: webhook Lark chỉ cho người sửa cấu hình`);
  }
  assert.ok(read("src/app/api/warehouses/notifications-overview/route.ts").includes('requirePermission("warehouse.update")'));
  const discover = read("src/app/api/cameras/discover/route.ts");
  assert.equal((discover.match(/requirePermission\("camera\.create"\)/g) ?? []).length, 2, "dò mạng: cả lệnh và kết quả");
  assert.ok(read("src/app/dashboard/agents/page.tsx").includes('guard(allowSetup, "cấp secret mới cho máy trạm"'));
});
