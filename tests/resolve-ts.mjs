/**
 * Resolver hook cho bộ test chạy bằng node --test.
 *
 * Source của app dùng bundler resolution: import không đuôi ("./foo") và
 * alias "@/lib/...". Node ESM không hiểu cả hai — nên trước đây bất kỳ
 * test nào import một module mà module ĐÓ lại import module khác đều nổ
 * ERR_MODULE_NOT_FOUND, dù bản thân file test viết đúng.
 *
 * Sửa ở đây chứ KHÔNG đi thêm đuôi .ts vào source app: cả codebase đang
 * viết không đuôi, đổi vì test runner là để cái đuôi kỳ lạ lại cho người
 * đọc code sau, đổi lấy đúng một dòng cấu hình tiết kiệm được.
 */

const SRC = new URL("../src/", import.meta.url);

/** Thử lần lượt các đuôi mà bundler tự suy ra. */
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  const spec = specifier.startsWith("@/")
    ? new URL(specifier.slice(2), SRC).href
    : specifier;

  try {
    return await nextResolve(spec, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    for (const ext of EXTENSIONS) {
      try {
        return await nextResolve(spec + ext, context);
      } catch {
        // thử đuôi tiếp theo
      }
    }
    throw err;
  }
}
