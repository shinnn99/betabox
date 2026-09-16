// ============================================================================
// check-client-writes-use-apifetch — chặn ở prebuild ca "client GHI bằng
// `fetch` trần".
//
// Vế 4 chỉ chạy khi request GHI mang header `x-render-org-id`, mà chỉ
// `apiFetch` gắn header đó. Một lời gọi `fetch` trần cho POST/PUT/PATCH/DELETE
// = một lỗ ghi-nhầm-org, đúng loại đã phá camera kho Đại Kim 2026-09-16.
//
// Bắt cả ca method là BIẾN (`method` thay vì `method: "PUT"`) — đó chính là ca
// codemod ban đầu bỏ sót ở CamerasView.tsx, và cũng là ca người viết tay dễ
// tạo ra nhất.
//
// Chạy: node scripts/check-client-writes-use-apifetch.mjs
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Ngoài dashboard: chưa đăng nhập, hoặc đang đổi chính ngữ cảnh org nên
 * không có `data-render-org-id` để đọc.
 */
const ALLOW_RAW_FETCH = new Set([
  "src/lib/api-fetch.tsx", // chính wrapper
  "src/app/login/page.tsx", // chưa đăng nhập → chưa có org
  "src/app/signup/page.tsx", // chưa có tài khoản
  "src/app/platform/page.tsx", // platform admin, không thuộc org nào
  "src/app/platform/orgs/[id]/page.tsx", // đang CHỌN org, chưa có ngữ cảnh
  "src/components/platform/ImpersonateBannerExitButton.tsx", // đang THOÁT ngữ cảnh
  "src/components/platform/ImpersonateWatcher.tsx", // theo dõi đổi ngữ cảnh
  "src/lib/lark/client.ts", // server-only, POST ra webhook Lark ngoài hệ
]);

const WRITE_VERB = /^(POST|PUT|PATCH|DELETE)$/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".tsx") || e.endsWith(".ts")) out.push(p.split("\\").join("/"));
  }
  return out;
}

const offenders = [];

for (const file of walk("src")) {
  if (file.includes("/api/")) continue; // route handler: fetch ra ngoài, không phải client
  if (ALLOW_RAW_FETCH.has(file)) continue;

  const src = readFileSync(file, "utf8");
  if (!/^\s*["']use client["']/m.test(src) && !file.startsWith("src/lib/")) continue;

  const lines = src.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    if (!/\bawait fetch\(/.test(lines[i])) continue;

    // Nhìn 12 dòng tiếp theo để tìm `method`.
    const window = lines.slice(i, i + 12).join("\n");

    // Dạng 1: method: "PUT"
    const literal = window.match(/method:\s*["'](\w+)["']/);
    // Dạng 2: method,  hoặc  method: someVar  → không biết chắc, cảnh báo.
    const variable = /method\s*[,}]/.test(window) || /method:\s*[A-Za-z_$]/.test(window);

    const isWrite = literal ? WRITE_VERB.test(literal[1].toUpperCase()) : variable;
    if (!isWrite) continue;

    offenders.push({
      file,
      line: i + 1,
      kind: literal ? literal[1].toUpperCase() : "method là biến",
      snippet: lines[i].trim().slice(0, 70),
    });
  }
}

if (offenders.length > 0) {
  console.error("\n✗ Client GHI bằng `fetch` trần — vế 4 không bảo vệ được:\n");
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  [${o.kind}]`);
    console.error(`      ${o.snippet}`);
  }
  console.error(
    `\n  Sửa: đổi \`fetch\` → \`apiFetch\` và thêm\n` +
      `      import { apiFetch } from "@/lib/api-fetch";\n` +
      `  Nếu đây là lời gọi ra ngoài hệ (không phải /api/*), thêm file vào\n` +
      `  ALLOW_RAW_FETCH trong script này kèm lý do.\n`
  );
  process.exit(1);
}

console.log("✓ Mọi lời gọi GHI ở client đều qua apiFetch (vế 4 còn hiệu lực)");
