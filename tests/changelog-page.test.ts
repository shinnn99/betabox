import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RELEASES,
  badgeOf,
  scaleFromVersion,
  scaleOf,
} from "../src/lib/changelog/releases.ts";

/**
 * Nhật ký cập nhật phiên bản (chủ dự án chốt 24/09/2026).
 *
 * Luật phân loại: đổi cách vận hành, hoặc máy kho nhảy số giữa (0.8 → 0.9)
 * là LỚN; chỉ nhảy số cuối (0.8.1 → 0.8.2) là NHỎ.
 */

test("số cuối bằng 0 là bản lớn, khác 0 là bản nhỏ", () => {
  for (const v of ["0.9.0", "0.10.0", "0.12.0", "1.0.0"]) {
    assert.equal(scaleFromVersion(v), "lon", `${v} phải là bản lớn`);
  }
  for (const v of ["0.8.9", "0.9.1", "0.10.1", "0.11.2"]) {
    assert.equal(scaleFromVersion(v), "nho", `${v} phải là bản nhỏ`);
  }
  // Số rác thì coi là nhỏ, không được ném lỗi làm sập cả trang.
  assert.equal(scaleFromVersion("linh tinh"), "nho");
  assert.equal(scaleFromVersion("0.9"), "nho");
});

test("hai mốc đổi cách vận hành phải nằm trong nhóm LỚN", () => {
  const big = RELEASES.filter((r) => scaleOf(r) === "lon").map((r) => r.title);
  assert.ok(
    big.some((t) => t.includes("hai camera")),
    "mốc một camera một máy quét → hai camera phải là bản lớn",
  );
  assert.ok(
    big.some((t) => t.includes("luồng hàng hoàn")),
    "mốc thêm luồng hàng hoàn phải là bản lớn",
  );
});

test("thay đổi chỉ trên web vẫn phân loại được", () => {
  const web = RELEASES.filter((r) => r.agentVersion === null);
  assert.ok(web.length > 0, "phải có mục chỉ đổi phần web");
  for (const r of web) assert.equal(badgeOf(r), "Web");
  // Phân quyền là đổi cách vận hành nên đặt tay thành LỚN.
  const perm = RELEASES.find((r) => r.title.includes("Phân quyền"));
  assert.equal(scaleOf(perm!), "lon");
});

test("danh sách xếp mới nhất trước và không thiếu nội dung", () => {
  const dates = RELEASES.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "mới nhất phải ở trên");
  for (const r of RELEASES) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.date), `ngày sai khuôn: ${r.date}`);
    assert.ok(r.title.trim().length > 0 && r.summary.trim().length > 0, r.title);
    assert.ok(r.items.length > 0, `${r.title}: phải có ít nhất một mục`);
    for (const item of r.items) {
      assert.ok(item.title.trim() && item.detail.trim(), `${r.title}: mục rỗng`);
    }
  }
});

test("trang nằm trong nhóm Quản lý hệ thống và đã khai quyền", () => {
  const nav = readFileSync("src/lib/nav.ts", "utf8");
  assert.ok(nav.includes('label: "Nhật ký cập nhật phiên bản"'));
  assert.ok(nav.includes('href: "/dashboard/settings/changelog"'));
  // Phải nằm SAU mục Nhật ký hệ thống, tức vẫn trong nhóm Quản lý hệ thống.
  assert.ok(
    nav.indexOf('href: "/dashboard/audit"') < nav.indexOf('href: "/dashboard/settings/changelog"'),
  );

  const access = readFileSync("src/lib/nav-access.ts", "utf8");
  assert.ok(access.includes('["/dashboard/settings/changelog", ["audit.view"]]'));
});

test("trang chỉ đọc — không có nút ghi nào", () => {
  const page = readFileSync("src/app/dashboard/settings/changelog/page.tsx", "utf8");
  assert.ok(!page.includes("apiFetch"), "trang này không gọi API ghi");
  assert.ok(!/method:\s*"(POST|PATCH|DELETE)"/.test(page));
  assert.ok(page.includes("Thay đổi lớn"), "có nhãn phân biệt bản lớn");
});
