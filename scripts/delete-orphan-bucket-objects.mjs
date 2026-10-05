#!/usr/bin/env node
/**
 * Dọn object MỒ CÔI trong bucket clip bằng chứng — chạy tay, một lần.
 *
 * "Mồ côi" = object nằm trên bucket mà KHÔNG dòng `order_proof_clips` nào có
 * `bucket_path` trỏ tới. Đo 02/10/2026: bucket 34 object/1421 MB trong khi
 * bảng clip chỉ nhận 31/1354 MB — 3 object, 67 MB, vẫn tính tiền lưu trữ mà
 * lượt dọn theo hạn clip không bao giờ chạm tới (nó đi từ bảng clip, không đi
 * từ bucket).
 *
 * VÌ SAO KHÔNG XOÁ BẰNG SQL: Supabase chặn `DELETE FROM storage.objects` bằng
 * trigger `storage.protect_delete()`. Chặn đúng — xoá dòng DB sẽ để lại file
 * thật nằm mồ côi trong S3, tức đổi một loại rác này lấy một loại rác khác
 * khó thấy hơn. Phải đi qua Storage API để xoá cả hai.
 *
 * AN TOÀN:
 *   * Mặc định CHẠY KHÔ (dry-run). Phải truyền --yes mới xoá thật.
 *   * Danh sách mồ côi tính lại NGAY TRƯỚC khi xoá, không dùng danh sách
 *     chép sẵn: clip vừa upload xong giữa lúc rà và lúc xoá sẽ tự loại ra.
 *   * In đầy đủ tên + dung lượng từng file trước khi đụng vào.
 *
 * Dùng:
 *   node --env-file=.env.local scripts/delete-orphan-bucket-objects.mjs
 *   node --env-file=.env.local scripts/delete-orphan-bucket-objects.mjs --yes
 */

import { createClient } from "@supabase/supabase-js";

const BUCKET = "proof-clips-transient";
const APPLY = process.argv.includes("--yes");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

/** Liệt kê đệ quy — Storage API chỉ trả một mức thư mục mỗi lượt. */
async function listAll(prefix = "") {
  const out = [];
  const { data, error } = await admin.storage
    .from(BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error(`list("${prefix}"): ${error.message}`);
  for (const entry of data ?? []) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Thư mục không có `id`; file thì có.
    if (entry.id === null || entry.id === undefined) {
      out.push(...(await listAll(path)));
    } else {
      out.push({ path, size: entry.metadata?.size ?? 0 });
    }
  }
  return out;
}

const objects = await listAll();
console.log(`Bucket ${BUCKET}: ${objects.length} file.`);

// Dòng clip nào đang giữ chỗ trên bucket — tính NGAY TRƯỚC khi xoá.
const { data: clips, error: clipErr } = await admin
  .from("order_proof_clips")
  .select("bucket_path")
  .not("bucket_path", "is", null);
if (clipErr) {
  console.error(`Không đọc được order_proof_clips: ${clipErr.message}`);
  process.exit(1);
}
const claimed = new Set((clips ?? []).map((c) => c.bucket_path));

const orphans = objects.filter((o) => !claimed.has(o.path));
const freed = orphans.reduce((n, o) => n + Number(o.size || 0), 0);

console.log(`Có chủ: ${objects.length - orphans.length} · Mồ côi: ${orphans.length}`);
if (orphans.length === 0) {
  console.log("Không có gì để dọn.");
  process.exit(0);
}
for (const o of orphans) {
  console.log(`  - ${o.path}  (${(Number(o.size || 0) / 1048576).toFixed(1)} MB)`);
}
console.log(`Tổng giải phóng: ${(freed / 1048576).toFixed(1)} MB`);

if (!APPLY) {
  console.log("\nCHẠY KHÔ — chưa xoá gì. Thêm --yes để xoá thật.");
  process.exit(0);
}

const { data: removed, error: rmErr } = await admin.storage
  .from(BUCKET)
  .remove(orphans.map((o) => o.path));
if (rmErr) {
  console.error(`Xoá thất bại: ${rmErr.message}`);
  process.exit(1);
}
console.log(`\nĐã xoá ${removed?.length ?? 0} file, giải phóng ${(freed / 1048576).toFixed(1)} MB.`);
