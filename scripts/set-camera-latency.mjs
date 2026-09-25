/**
 * Đặt độ trễ luồng cho một camera.
 *
 * Dùng sau khi đo bằng đồng hồ bấm giờ (xem
 * `docs/camera-giam-do-tre-toan-canh.md` mục 2). Chạy được nhiều lần, mỗi
 * lần đo lại thì chạy lại với số mới.
 *
 * Dương = camera về CHẬM hơn mốc quét → cửa sổ cắt clip dịch muộn lại.
 * Mốc quét sinh ra từ camera QR nên độ trễ của CHÍNH camera QR tự triệt
 * tiêu — để camera QR là 0, chỉ đặt cho các camera còn lại.
 *
 * Dùng:
 *   node scripts/set-camera-latency.mjs                 # xem hiện tại
 *   node scripts/set-camera-latency.mjs CTC01 1000      # đặt 1000ms
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const [maCamera, soMs] = process.argv.slice(2);
const ORG_NAME = "Đại Kim";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .ilike("name", `%${ORG_NAME}%`)
    .single();

  if (maCamera && soMs !== undefined) {
    const ms = Number(soMs);
    if (!Number.isInteger(ms) || ms < -5000 || ms > 5000) {
      throw new Error(`Số mili giây phải là số nguyên trong khoảng -5000..5000, nhận "${soMs}"`);
    }
    const { error } = await db
      .from("cameras")
      .update({ stream_latency_ms: ms })
      .eq("organization_id", org.id)
      .eq("camera_code", maCamera);
    if (error) throw new Error(error.message);
    console.log(`Đã đặt ${maCamera} = ${ms}ms\n`);
  }

  const { data: cams, error: docLoi } = await db
    .from("cameras")
    .select("camera_code, name, stream_latency_ms")
    .eq("organization_id", org.id)
    .order("camera_code");
  if (docLoi) {
    // Hay gặp nhất: chưa chạy migration. Nuốt lỗi ở đây thì script in ra
    // danh sách rỗng, người chạy tưởng kho không có camera nào.
    throw new Error(
      `${docLoi.message}

Nếu lỗi nhắc tới cột stream_latency_ms thì chưa chạy migration ` +
        `supabase/migrations/20260925120000_camera_stream_latency.sql`,
    );
  }
  console.log(`Kho: ${org.name}`);
  for (const c of cams ?? []) {
    const ms = c.stream_latency_ms ?? 0;
    const nhan = ms === 0 ? "chưa hiệu chỉnh" : ms > 0 ? `về chậm ${ms}ms` : `về sớm ${-ms}ms`;
    console.log(`  ${String(c.camera_code).padEnd(10)} ${String(ms).padStart(6)}ms   ${nhan}`);
  }
}

void main();
