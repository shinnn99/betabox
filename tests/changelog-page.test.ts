import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  RELEASES,
  badgeOf,
  scaleFromVersion,
  scaleOf,
} from "../src/lib/changelog/releases.ts";
import { collectReleases, parseReleaseSection } from "../src/lib/changelog/parse.ts";

/**
 * Nhật ký phiên bản (chủ dự án chốt 24/09/2026, đổi tên 25/09/2026).
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

test("trang nằm ở menu platform, KHÔNG còn ở menu kho", () => {
  // Chủ dự án chốt 25/09/2026: chuyển hẳn sang platform, không nhân đôi.
  const platformNav = readFileSync("src/lib/platform-nav.ts", "utf8");
  assert.ok(platformNav.includes('label: "Nhật ký phiên bản"'));
  assert.ok(platformNav.includes('href: "/platform/changelog"'));

  const nav = readFileSync("src/lib/nav.ts", "utf8");
  assert.ok(
    !nav.includes("/dashboard/settings/changelog"),
    "menu kho không được còn mục này",
  );

  // Kiểm entry THẬT trong bảng, không kiểm chú thích — đường dẫn cũ được
  // nhắc trong comment để giải thích vì sao nó không còn ở đây.
  const access = readFileSync("src/lib/nav-access.ts", "utf8");
  assert.ok(
    !access.includes('["/dashboard/settings/changelog"'),
    "gỡ khỏi nav-access để chặn cả đường gõ thẳng đường dẫn",
  );
  assert.ok(!access.includes('["/dashboard/audit"'));
});

test("trang chỉ đọc — không có nút ghi nào", () => {
  const page = readFileSync(
    "src/components/changelog/ChangelogTimeline.tsx",
    "utf8",
  );
  assert.ok(!page.includes("apiFetch"), "trang này không gọi API ghi");
  assert.ok(!/method:\s*"(POST|PATCH|DELETE)"/.test(page));
  assert.ok(page.includes("Thay đổi lớn"), "có nhãn phân biệt bản lớn");
});

test("máy kho lên phiên bản mới thì nhật ký phải có mục tương ứng", () => {
  // Chốt chống quên: nội dung trang là file viết tay, không tự sinh ra.
  // Nếu ai đó nâng số phiên bản máy kho mà không viết mục cho người dùng,
  // bài test này đỏ ngay tại chỗ thay vì phát hiện sau khi khách đã dùng.
  const pkg = JSON.parse(readFileSync("warehouse-agent/package.json", "utf8")) as {
    version: string;
  };
  const versions = RELEASES.map((r) => r.agentVersion).filter((v): v is string => v !== null);
  assert.ok(
    versions.includes(pkg.version),
    `máy kho đang là ${pkg.version} nhưng Nhật ký phiên bản chưa có mục nào cho bản này — ` +
      `thêm vào src/lib/changelog/releases.ts (mới nhất ở trên).`,
  );

  // Bộ cài đã phát hành cũng phải có mục: file nằm trong repo là bằng chứng
  // bản đó đã tới tay người dùng.
  if (existsSync("warehouse-agent/releases")) {
    for (const file of readdirSync("warehouse-agent/releases")) {
      const m = /BetacomAgentSetup-v(\d+\.\d+\.\d+)\.exe$/.exec(file);
      if (!m) continue;
      assert.ok(
        versions.includes(m[1]),
        `đã phát hành bộ cài ${file} nhưng nhật ký chưa có mục cho bản ${m[1]}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Nguồn nội dung là thư mục changelog/ — giao diện chỉ đọc lại
// ---------------------------------------------------------------------------

test("nội dung trên giao diện khớp đúng với thư mục changelog/", () => {
  // Sửa markdown mà quên chạy lại bộ sinh thì bài này đỏ, kèm cách sửa.
  const files = readdirSync("changelog")
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, content: readFileSync(`changelog/${name}`, "utf8") }));
  assert.deepEqual(
    RELEASES,
    collectReleases(files),
    "generated.ts đã cũ — chạy: pnpm build:changelog",
  );
});

test("bộ đọc hiểu đúng khuôn, và từ chối khuôn sai", () => {
  const md = [
    "# 24/09/2026",
    "",
    "## Việc kỹ thuật trong ngày",
    "- sửa hàm abc trong file xyz.ts",
    "",
    "## Phát hành cho người dùng",
    "",
    "<!-- ban: agent=0.12.0 -->",
    "### Tiêu đề bản phát hành",
    "Đoạn tóm tắt.",
    "",
    "#### [Mới] Mục một",
    "Chi tiết mục một.",
    "",
    "#### [Sửa lỗi] Mục hai",
    "Chi tiết mục hai.",
    "",
    "## Mục kỹ thuật khác",
    "- không được đọc vào đây",
  ].join("\n");

  const out = parseReleaseSection(md, "2026-09-24");
  assert.equal(out.length, 1);
  assert.equal(out[0].agentVersion, "0.12.0");
  assert.equal(out[0].title, "Tiêu đề bản phát hành");
  assert.equal(out[0].summary, "Đoạn tóm tắt.");
  assert.deepEqual(
    out[0].items.map((i) => [i.tag, i.title]),
    [
      ["Mới", "Mục một"],
      ["Sửa lỗi", "Mục hai"],
    ],
  );
  assert.equal(scaleOf(out[0]), "lon", "0.12.0 là bản lớn");

  // File nhật ký kỹ thuật thuần thì không đẩy gì ra giao diện.
  assert.deepEqual(parseReleaseSection("# 14/09\n\n## Việc trong ngày\n- abc", "2026-09-14"), []);

  // Nhãn lạ phải báo lỗi ngay lúc build, không im lặng bỏ qua.
  const badTag = [
    "## Phát hành cho người dùng",
    "### Tiêu đề",
    "Tóm tắt.",
    "#### [Linh tinh] Mục",
    "Chi tiết.",
  ].join("\n");
  assert.throws(() => parseReleaseSection(badTag, "2026-09-24"), /không hợp lệ/);

  // Thiếu tóm tắt cũng phải báo.
  const noSummary = [
    "## Phát hành cho người dùng",
    "### Tiêu đề",
    "#### [Mới] Mục",
    "Chi tiết.",
  ].join("\n");
  assert.throws(() => parseReleaseSection(noSummary, "2026-09-24"), /thiếu đoạn tóm tắt/);
});
