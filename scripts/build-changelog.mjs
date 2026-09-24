/**
 * Đọc phần "Phát hành cho người dùng" trong `changelog/*.md` và ghi ra
 * `src/lib/changelog/generated.json` để giao diện dùng.
 *
 * Vì sao sinh ra file thay vì đọc thẳng lúc chạy: trang này được đóng gói
 * và chạy trên Vercel, nơi thư mục `changelog/` không đi theo bản build.
 * Sinh lúc build thì nội dung nằm trong chính gói chạy, không phụ thuộc
 * đường dẫn trên máy chủ.
 *
 * Chạy tự động trước `pnpm build`. Chạy tay: node scripts/build-changelog.mjs
 * Bài test `tests/changelog-page.test.ts` canh file sinh ra khớp với
 * `changelog/` — sửa markdown mà quên chạy lại thì test đỏ.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SOURCE_DIR = join(ROOT, "changelog");
const OUT_FILE = join(ROOT, "src", "lib", "changelog", "generated.ts");

export function readChangelogFiles() {
  return readdirSync(SOURCE_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, content: readFileSync(join(SOURCE_DIR, name), "utf8") }));
}

export async function buildReleases() {
  const { collectReleases } = await import("../src/lib/changelog/parse.ts");
  return collectReleases(readChangelogFiles());
}

/**
 * Xuất ra .ts chứ không phải .json: Node ESM đòi cú pháp
 * `with { type: "json" }` khi nhập JSON, mà bộ test chạy thẳng bằng Node.
 * File .ts chạy được ở cả hai nơi và còn được kiểm kiểu.
 */
export function serialize(releases) {
  return [
    "// FILE NÀY DO MÁY SINH RA — đừng sửa tay.",
    '// Nguồn: phần "Phát hành cho người dùng" trong changelog/*.md',
    "// Sinh lại: pnpm build:changelog",
    "",
    'import type { Release } from "./types";',
    "",
    `export const GENERATED_RELEASES: Release[] = ${JSON.stringify(releases, null, 2)};`,
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releases = await buildReleases();
  writeFileSync(OUT_FILE, serialize(releases), "utf8");
  console.log(`changelog: ${releases.length} bản phát hành -> src/lib/changelog/generated.ts`);
}
