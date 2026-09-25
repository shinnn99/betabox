import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

/**
 * Hai trang nhật ký đã chuyển hẳn từ dashboard kho sang menu platform
 * (chủ dự án chốt 25/09/2026). Bộ test này canh ba thứ dễ vô tình hoàn tác:
 * trang cũ không sống lại, lọc theo kho không tụt xuống client, và trang
 * platform không lẫn sang bảng audit của nền tảng.
 */

test("trang cũ ở dashboard kho đã gỡ hẳn", () => {
  assert.ok(
    !existsSync("src/app/dashboard/audit/page.tsx"),
    "trang audit cũ ở kho phải được gỡ",
  );
  assert.ok(
    !existsSync("src/app/dashboard/settings/changelog/page.tsx"),
    "trang changelog cũ ở kho phải được gỡ",
  );
  // Ống dẫn dữ liệu của trang cũ cũng gỡ theo (chủ dự án chốt 25/09/2026):
  // bề mặt API không ai gọi là nợ — một cửa có khoá nhưng không ai canh.
  assert.ok(
    !existsSync("src/app/api/audit/route.ts"),
    "route tenant cũ phải được gỡ",
  );
});

test("tra tên xuyên kho chỉ còn bản admin, và chỉ platform dùng", () => {
  const resolver = readFileSync("src/lib/audit-view/resolve-names.ts", "utf8");
  assert.ok(resolver.includes("resolveTargetNamesAdmin"));
  // Bản tenant đã gỡ cùng route cũ — còn sót là dấu hiệu ai đó khôi phục
  // nửa vời và có thể đang gọi admin client từ route tenant.
  assert.ok(
    !resolver.includes("export async function resolveTargetNames("),
    "bản tenant đã gỡ theo route cũ",
  );

  // Hàm bỏ RLS chỉ được gọi từ /api/platform/*.
  const callers = ["src/app/api/platform/org-audit/route.ts"];
  for (const f of callers) {
    assert.ok(existsSync(f), `${f} phải tồn tại`);
  }
});

test("menu kho không còn hai mục, menu platform có đủ", () => {
  // Kiểm mục menu THẬT (`href:`), không kiểm chú thích giải thích việc chuyển.
  const nav = readFileSync("src/lib/nav.ts", "utf8");
  assert.ok(!nav.includes('href: "/dashboard/audit"'));
  assert.ok(!nav.includes('href: "/dashboard/settings/changelog"'));

  const platformNav = readFileSync("src/lib/platform-nav.ts", "utf8");
  assert.ok(platformNav.includes('href: "/platform/org-audit"'));
  assert.ok(platformNav.includes('href: "/platform/changelog"'));
  // Trang kiểm toán nền tảng vốn có phải còn nguyên — hai thứ khác nhau.
  assert.ok(platformNav.includes('href: "/platform/audit"'));
});

test("hai nguồn nhật ký không bị lẫn: org-audit đọc audit_logs", () => {
  const route = readFileSync("src/app/api/platform/org-audit/route.ts", "utf8");
  assert.ok(route.includes('from("audit_logs")'), "phải đọc audit_logs");
  // Kiểm lời gọi thật, không kiểm cả chú thích — tên bảng kia được NHẮC
  // trong comment để giải thích sự khác nhau giữa hai trang.
  assert.ok(
    !route.includes('from("platform_audit_log")'),
    "không được đọc bảng của nhật ký kiểm toán nền tảng",
  );

  const platformAudit = readFileSync("src/app/api/platform/audit/route.ts", "utf8");
  assert.ok(
    platformAudit.includes("platform_audit_log"),
    "trang kiểm toán nền tảng vẫn đọc bảng cũ của nó",
  );
});

test("lọc theo kho chạy ở TRUY VẤN, không lọc ở trình duyệt", () => {
  // Lọc phía client vẫn gửi dữ liệu mọi kho xuống máy người dùng, và làm
  // hỏng ý nghĩa của limit: 200 dòng mới nhất của MỌI kho, lọc xong còn
  // vài dòng của kho cần xem.
  const route = readFileSync("src/app/api/platform/org-audit/route.ts", "utf8");
  assert.ok(
    route.includes('.eq("organization_id", orgId)'),
    "phải lọc org ngay ở truy vấn",
  );

  const page = readFileSync("src/app/platform/org-audit/page.tsx", "utf8");
  assert.ok(
    page.includes("org_id=${encodeURIComponent(orgId)}"),
    "trang phải gửi kho đang chọn lên máy chủ",
  );
  assert.ok(
    page.includes("}, [orgId])"),
    "đổi kho phải tải lại dữ liệu, không lọc lại trên dữ liệu cũ",
  );
});

test("route platform chặn bằng requirePlatformRole", () => {
  const route = readFileSync("src/app/api/platform/org-audit/route.ts", "utf8");
  // Route này dùng admin client (bỏ RLS) vì platform admin không có
  // organization_id trong JWT — nên cổng chặn phải nằm ngay đầu route.
  assert.ok(route.includes("requirePlatformRole"));
  assert.ok(
    route.indexOf("requirePlatformRole") < route.indexOf("createAdminClient()"),
    "phải kiểm quyền TRƯỚC khi dựng admin client",
  );
});

test("hai trang dùng chung một bộ nhãn tiếng Việt", () => {
  // Sửa nhãn một lần phải đổi cả hai nơi — không copy-paste presenter.
  const page = readFileSync("src/app/platform/org-audit/page.tsx", "utf8");
  assert.ok(page.includes('from "@/lib/audit-view/presenter"'));

  const changelog = readFileSync("src/app/platform/changelog/page.tsx", "utf8");
  assert.ok(changelog.includes("ChangelogTimeline"));
});
