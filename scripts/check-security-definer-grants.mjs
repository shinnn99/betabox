#!/usr/bin/env node
// CI guard: hàm SECURITY DEFINER ở schema `public` phải REVOKE tường minh
// khỏi `authenticated` (và `anon`).
//
// BẰNG CHỨNG ĐÃ CẮN (production, 05/10/2026):
//
//   set local role authenticated;
//   select count(*), sum(segments)
//   from public.recording_daily_usage('e3cb7cd1-…', 14);
//   → 13 ngày, 11.153 segment
//
// Một tài khoản bất kỳ, của BẤT KỲ kho nào, đọc được trọn số liệu ghi hình
// của kho khác chỉ bằng cách đổi `p_organization_id`.
//
// VÌ SAO LỖ SINH RA — hai thứ cộng lại:
//   1. SECURITY DEFINER làm RLS của bảng gốc KHÔNG áp.
//   2. `pg_default_acl` của schema `public` trên Supabase tự cấp EXECUTE cho
//      `anon` + `authenticated` với MỌI hàm mới. Mặc định là MỞ.
// Nên thiếu dòng REVOKE không phải "quên một bước cho chắc" — nó là mở cửa.
//
// Vì sao sót được dù đợt đó có người rà: ba migration cùng ngày 02/10,
// `storage_usage_fn` CÓ revoke, hai bản `recording_daily_usage` thì không —
// khối GRANT của bản sau chép từ bản trước nên lỗi nhân đôi. Mắt người đọc
// bốn dòng GRANT gần giống nhau rất dễ trượt; máy thì không.
//
// Script này đọc file migration (không nối DB, chạy được trong prebuild):
// tìm `CREATE FUNCTION ... SECURITY DEFINER` ở schema public, rồi đòi có
// REVOKE khỏi `authenticated` và `anon` cho đúng tên hàm đó.
//
// HAI ĐIỀU PHẢI LOẠI, nếu không script vô dụng vì nhiễu (bản nháp đầu báo 51
// hàm trong khi DB thật chỉ có 2 — mà một gate kêu oan 49 lần thì người ta
// tắt nó, không phải đọc nó):
//
//   1. TRIGGER FUNCTION (`RETURNS trigger`) — PostgREST không gọi được, chỉ
//      trigger của bảng gọi. Quyền EXECUTE của `authenticated` ở đây vô
//      nghĩa. Đây là phần lớn 49 ca nhiễu.
//   2. Hàm đã REVOKE ở MIGRATION SAU. Quyền là trạng thái tích luỹ qua thời
//      gian, không phải thuộc tính của một file: `CREATE` ở file A rồi
//      `REVOKE` ở file B là hoàn toàn đúng. Soi từng file riêng lẻ sẽ kết
//      luận sai.
//
// Đã đối chiếu với DB thật 05/10/2026 — sau khi loại hai nhóm trên, kết quả
// script khớp đúng tập hàm mà `has_function_privilege('authenticated', …)`
// trả true. Truy vấn dùng để đối chiếu nằm trong migration
// 20261005134612_revoke_recording_daily_usage_from_authenticated.sql.
//
// Giới hạn đã biết — nói thẳng chứ không để người đọc tưởng script phủ hết:
//   * Chỉ soi repo, KHÔNG soi DB thật. Hàm tạo tay qua SQL Editor nằm ngoài
//     tầm (cọc "Paste SQL Editor không track migration"). Script này chặn
//     NGUỒN MỚI; nó không thay cho việc query DB khi cần biết trạng thái.
//   * Khớp theo TÊN hàm, không theo chữ ký. Hai overload cùng tên khác tham
//     số được coi là một — nghiêng về bỏ sót hơn là kêu oan.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");

// `CREATE [OR REPLACE] FUNCTION [public.]ten(`
const CREATE_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;

/**
 * Phần khai báo của hàm: từ CREATE tới khi mở body (`AS $$`), hoặc tới `;`
 * nếu không có body dollar-quoted.
 *
 * Cắt khúc thay vì soi cả file: một file có thể chứa nhiều hàm, hàm A là
 * DEFINER còn hàm B thì không, hàm A trả trigger còn hàm B trả table.
 * Thiếu bước cắt này thì mọi hàm trong file bị gán chung một kết luận.
 */
function declarationOf(sql, fromIndex) {
  const bodyStart = sql.indexOf("$$", fromIndex);
  const semi = sql.indexOf(";", fromIndex);
  const end =
    bodyStart !== -1 && (semi === -1 || bodyStart < semi) ? bodyStart : semi;
  return sql.slice(fromIndex, end === -1 ? sql.length : end);
}

/**
 * `fn` có bị REVOKE khỏi `role` trong đoạn SQL này.
 *
 * Phải nhận BA cách viết đang có thật trong repo — bản nháp đầu chỉ nhận
 * cách thứ nhất nên kêu oan 32 ca (so với DB thật thì cả 32 đều đã kín):
 *
 *   1. REVOKE ALL ON FUNCTION public.f(uuid) FROM authenticated;
 *   2. REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon, authenticated;
 *      → role nằm trong danh sách, không đứng ngay sau FROM
 *      (20260921130000_return_capture_sessions.sql và các bản họ hàng)
 *   3. EXECUTE format('REVOKE ALL ON FUNCTION public.%I(...) FROM authenticated', fn)
 *      → tên hàm là %I trong vòng lặp, không có mặt ở dạng chữ
 *      (20260930100000_operations_report_rpcs.sql)
 *
 * Cách 3 KHÔNG khớp được theo tên hàm (tên là `%I` trong vòng lặp), nên chỉ
 * được tin trong CHÍNH file khai báo hàm — không được tính cho các file sau.
 *
 * Nếu tính cho file sau thì một `EXECUTE format('REVOKE...` bất kỳ sẽ che
 * MỌI hàm khai báo trước nó. Đúng lỗi đó đã xảy ra khi viết script này:
 * `station_current_mode` (20260921100000) lọt vì `ops_report_rpcs`
 * (20260930100000) có revoke động — trong khi DB thật cho thấy nó đang hở.
 * Bắt được nhờ đối chiếu DB, không nhờ đọc lại code.
 */
function hasRevoke(sql, fn, role) {
  // Cách 1 + 2: tên hàm viết thẳng, role đứng sau FROM (có thể trong danh sách).
  const direct = new RegExp(
    String.raw`\bREVOKE\s+(?:ALL|EXECUTE)[\s\S]*?\bON\s+FUNCTION\s+(?:public\.)?${fn}\s*\([^)]*\)\s*FROM\s+[^;]*\b${role}\b`,
    "i",
  );
  return direct.test(sql);
}

/** Cách 3 — chỉ tin trong chính file khai báo hàm. Xem ghi chú ở hasRevoke. */
function hasDynamicRevoke(sql, role) {
  const re = new RegExp(
    String.raw`EXECUTE\s+format\(\s*'REVOKE[^']*FROM[^']*\b${role}\b`,
    "i",
  );
  return re.test(sql);
}

const files = readdirSync(MIG_DIR)
  .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
  .sort();

// Đọc hết một lượt rồi mới kết luận: cần biết các migration SAU có revoke
// hộ không. Quyền là trạng thái tích luỹ, không phải thuộc tính một file.
const sources = files.map((file) => ({
  file,
  sql: readFileSync(path.join(MIG_DIR, file), "utf8"),
}));

/**
 * `fn` có bị revoke khỏi `role` ở BẤT KỲ migration nào — trước hay sau.
 *
 * Vì sao không chỉ xét từ file khai báo trở đi: `CREATE OR REPLACE FUNCTION`
 * KHÔNG reset ACL. Hàm được REVOKE ở migration cũ rồi sửa body bằng
 * `CREATE OR REPLACE` ở migration mới thì quyền vẫn kín — file mới không cần
 * nhắc lại REVOKE.
 *
 * Đúng cạnh này đã làm script kêu oan 10 ca: `lark_digest_per_staff` REVOKE ở
 * 20260713220000 rồi `CREATE OR REPLACE` ở ba file sau; DB thật
 * `has_function_privilege('authenticated', …)` = false cho cả 10.
 *
 * Hệ quả đã biết và CHẤP NHẬN: nếu ai đó `DROP` hàm rồi `CREATE` lại (DROP
 * thì ACL mất thật) mà quên REVOKE, script này cho qua. Đổi lại, nó không
 * kêu oan — và một gate kêu oan sẽ bị tắt. Trục DROP-rồi-CREATE phải bắt
 * bằng cách query DB như đã làm 05/10/2026, không bắt bằng grep repo.
 */
function revokedAnywhere(fn, role) {
  return sources.some(({ sql }) => hasRevoke(sql, fn, role));
}

const problems = [];
let checkedFns = 0;
let skippedTriggers = 0;
const filesWithDefiner = new Set();

sources.forEach(({ file, sql }) => {
  if (!/\bSECURITY\s+DEFINER\b/i.test(sql)) return;

  let m;
  CREATE_RE.lastIndex = 0;
  while ((m = CREATE_RE.exec(sql)) !== null) {
    const fn = m[1];
    const decl = declarationOf(sql, m.index);
    if (!/\bSECURITY\s+DEFINER\b/i.test(decl)) continue;

    // Trigger function: không gọi qua PostgREST được.
    if (/\bRETURNS\s+trigger\b/i.test(decl)) {
      skippedTriggers++;
      continue;
    }

    filesWithDefiner.add(file);
    checkedFns++;

    const missing = ["authenticated", "anon"].filter(
      (role) => !revokedAnywhere(fn, role) && !hasDynamicRevoke(sql, role),
    );
    if (missing.length > 0) problems.push({ file, fn, missing });
  }
});

if (problems.length > 0) {
  console.error(
    "[check-security-definer-grants] Hàm SECURITY DEFINER thiếu REVOKE tường minh:\n",
  );
  for (const p of problems) {
    console.error(`  ${p.file}`);
    console.error(`    public.${p.fn}() — thiếu REVOKE khỏi: ${p.missing.join(", ")}`);
  }
  console.error(
    [
      "",
      "SECURITY DEFINER bỏ qua RLS của bảng gốc, mà schema `public` của Supabase",
      "mặc định cấp EXECUTE cho anon + authenticated. Thiếu REVOKE = bất kỳ tài",
      "khoản đăng nhập nào cũng gọi được, truyền org_id nào cũng đọc ra dữ liệu.",
      "",
      "Thêm vào cuối migration (trước COMMIT), đúng chữ ký hàm:",
      "",
      "  REVOKE ALL ON FUNCTION public.<ten>(<kieu>) FROM PUBLIC;",
      "  REVOKE ALL ON FUNCTION public.<ten>(<kieu>) FROM anon;",
      "  REVOKE ALL ON FUNCTION public.<ten>(<kieu>) FROM authenticated;",
      "  GRANT EXECUTE ON FUNCTION public.<ten>(<kieu>) TO service_role;",
      "",
      "Nếu hàm CỐ Ý cho người đăng nhập gọi: vẫn phải REVOKE rồi GRANT lại cho",
      "authenticated một cách tường minh, và hàm phải tự lọc theo org của",
      "người gọi (auth.uid()) chứ không tin tham số org_id truyền vào.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `[check-security-definer-grants] ${checkedFns} hàm SECURITY DEFINER gọi được qua API ` +
    `trong ${filesWithDefiner.size} file, đều có REVOKE tường minh ` +
    `(bỏ qua ${skippedTriggers} trigger function — không gọi qua PostgREST).`,
);
