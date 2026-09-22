// ============================================================================
// check-write-routes-pass-request — chặn ở prebuild ca "route GHI quên truyền
// Request vào guard".
//
// Vì sao cần: vế 4 (chống ghi-nhầm org) chỉ chạy được khi guard biết method
// của request. Guard lấy method từ tham số `req` mà route truyền vào
// requirePermission/requirePermissionStrict. Quên truyền → guard tưởng là
// request đọc → bỏ qua kiểm tra → lỗ mở lại y như sự cố 2026-09-16
// (camera kho Đại Kim bị ghi đè, mất ghi hình ~24 giờ).
//
// Quên một lời gọi là chuyện sẽ xảy ra. Script này biến nó từ "im lặng mất
// bảo vệ" thành "build đỏ".
//
// Chạy: node scripts/check-write-routes-pass-request.mjs
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = "src/app/api";
const WRITE_HANDLER =
  /export async function (POST|PUT|PATCH|DELETE)\s*\(([\s\S]*?)\)\s*[:{]/g;
const GUARD_CALL = /require(?:Permission|PermissionStrict)\s*\(([\s\S]*?)\)/g;

/**
 * Route dưới /api/agent/* dùng HMAC (verifyAgentRequest), không đi qua
 * guard tenant — agent không có phiên trình duyệt nên không có tab để nhầm.
 * /api/platform/impersonate đổi chính ngữ cảnh org nên không thể tự so.
 */
const EXEMPT = [/^src\/app\/api\/agent\//, /^src\/app\/api\/platform\/impersonate\//];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === "route.ts") out.push(p.split("\\").join("/"));
  }
  return out;
}

const offenders = [];

for (const file of walk(API_DIR)) {
  if (EXEMPT.some((re) => re.test(file))) continue;
  const src = readFileSync(file, "utf8");

  WRITE_HANDLER.lastIndex = 0;
  let match;
  while ((match = WRITE_HANDLER.exec(src))) {
    const [, verb, params] = match;
    const start = match.index;
    const next = src.indexOf("export async function", start + 10);
    const body = src.slice(start, next === -1 ? src.length : next);

    GUARD_CALL.lastIndex = 0;
    let guard;
    while ((guard = GUARD_CALL.exec(body))) {
      const args = guard[1];
      // Tham số thứ hai là Request. Có dấu phẩy ở mức ngoài cùng là đủ —
      // guard chỉ nhận đúng 2 tham số.
      const passesRequest = args.includes(",");
      if (!passesRequest) {
        const firstParam = (params.split(",")[0] ?? "").trim();
        offenders.push({ file, verb, firstParam, call: guard[0].slice(0, 60) });
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "\n✗ Route GHI gọi guard mà KHÔNG truyền Request — vế 4 bị vô hiệu:\n"
  );
  for (const o of offenders) {
    console.error(`  ${o.file}  ${o.verb}(${o.firstParam})`);
    console.error(`      ${o.call}...`);
  }
  console.error(
    `\n  Sửa: thêm tham số thứ hai là Request của handler, ví dụ\n` +
      `      requirePermissionStrict("camera.update", req)\n` +
      `  Nếu handler đang bỏ qua tham số đầu (\`_req\`), đổi thành \`req\`.\n`
  );
  process.exit(1);
}

console.log("✓ Mọi route GHI đều truyền Request vào guard (vế 4 còn hiệu lực)");
