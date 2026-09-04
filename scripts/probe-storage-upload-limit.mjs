#!/usr/bin/env node
/**
 * Đo TRẦN UPLOAD THẬT của Supabase Storage bằng PUT tăng dần.
 *
 * Vì sao cần đo thay vì đọc ô cấu hình trên dashboard: con số 50 MiB
 * đang nằm khắp codebase không đến từ dashboard mà từ phép đo
 * 2026-08-07 (50 MiB → 200, 51 MiB → 413 EntityTooLarge). Trần hiệu lực
 * là kết quả của cả tầng project lẫn tầng bucket, và ô cấu hình có thể
 * đã lưu mà chưa áp. Đổi trần xong thì đo lại, đừng tin ô nhập.
 *
 * Đi ĐÚNG đường agent đi: xin signed upload URL rồi PUT thẳng lên đó với
 * `content-type: video/mp4` (bucket chỉ nhận mp4). Khác đường thì kết
 * quả không nói được gì về đường thật.
 *
 * Chạy (từ gốc repo, cần .env.local có SUPABASE_SERVICE_ROLE_KEY):
 *   node scripts/probe-storage-upload-limit.mjs            # 50 90 100 101
 *   node scripts/probe-storage-upload-limit.mjs 95 100 105
 *
 * LƯU Ý: script này GHI THẬT vào bucket production, dưới prefix
 * `_limit-probe/` (không đụng path của org nào), và xoá ngay sau mỗi
 * lần đo — kể cả khi PUT fail. Nếu script bị giết giữa chừng, object
 * thừa nằm ở prefix đó; xoá tay hoặc để TTL dọn.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIB = 1024 * 1024;
const BUCKET = "proof-clips-transient";

const envRaw = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
const env = {};
for (const line of envRaw.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    "Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env.local",
  );
  process.exit(1);
}

const sizesMib = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["50", "90", "100", "101"]
).map((s) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Kích thước không hợp lệ: ${s}`);
    process.exit(1);
  }
  return n;
});

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`Project: ${SUPABASE_URL}`);
console.log(`Bucket:  ${BUCKET}`);
console.log(`Đo:      ${sizesMib.join(", ")} MiB\n`);

const results = [];

for (const mib of sizesMib) {
  const objectPath = `_limit-probe/probe-${mib}mib-${process.pid}.mp4`;
  let status = null;
  let detail = "";

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(objectPath, { upsert: true });

  if (signErr || !signed) {
    results.push({ mib, status: "—", detail: `signed_url_failed: ${signErr?.message}` });
    console.log(`${String(mib).padStart(4)} MiB  →  xin signed URL FAIL: ${signErr?.message}`);
    continue;
  }

  const body = Buffer.alloc(Math.round(mib * MIB));
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(signed.signedUrl, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body,
    });
    status = res.status;
    if (!res.ok) detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
  } catch (err) {
    detail = `network: ${err.message}`;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  // Dọn NGAY, kể cả khi PUT fail (fail có thể vẫn tạo object rỗng).
  await supabase.storage.from(BUCKET).remove([objectPath]);

  results.push({ mib, status: status ?? "ERR", detail });
  const verdict = status === 200 ? "OK" : status === 413 ? "413 QUÁ TRẦN" : `HTTP ${status ?? "ERR"}`;
  console.log(
    `${String(mib).padStart(4)} MiB  →  ${verdict.padEnd(14)} ${ms.toFixed(0)}ms  ${detail}`,
  );
}

// Kết luận: trần nằm giữa mốc OK lớn nhất và mốc fail nhỏ nhất.
const okMax = results.filter((r) => r.status === 200).map((r) => r.mib).sort((a, b) => b - a)[0];
const failMin = results.filter((r) => r.status !== 200).map((r) => r.mib).sort((a, b) => a - b)[0];

console.log("");
if (okMax === undefined) {
  console.log("Không mốc nào PUT được — kiểm lại key/bucket trước khi kết luận về trần.");
} else if (failMin === undefined) {
  console.log(`Mọi mốc đã thử đều PUT được. Trần ≥ ${okMax} MiB — thử mốc cao hơn nếu cần biết chính xác.`);
} else {
  console.log(`Trần thật nằm trong khoảng: ${okMax} MiB OK, ${failMin} MiB fail.`);
}
