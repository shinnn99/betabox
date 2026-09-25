/**
 * Cắt ngắn các đoạn video có độ dài phi lý (sự cố kho Đại Kim 25/09/2026).
 *
 * Máy kho cắt đoạn 60 giây một (`-segment_time 60`). Nhưng có những bản
 * ghi để trống giờ kết thúc từ lâu, rồi tới lúc nào đó được đóng bằng giờ
 * HIỆN TẠI — thành ra một đoạn "dài 8 ngày":
 *
 *   CTC01/2026/09/17/CTC01_20260917_091547.mp4
 *     bắt đầu 17/09 02:15:47 · kết thúc 25/09 02:38:20 · dài 692.553 giây
 *
 * Đoạn ma đó phủ lên MỌI cửa sổ cắt clip suốt 8 ngày. Hệ thống tưởng nó
 * chứa hình của mọi đơn trong khoảng ấy, đưa vào danh sách ghép, và ffmpeg
 * nhận một file không khớp → clip ra không có luồng hình → máy kho báo
 * `unsupported_output_codec`. Đúng lỗi đơn ngày 24/09 gặp sáng nay.
 *
 * Sửa: đoạn nào dài quá ngưỡng thì đặt lại kết thúc = bắt đầu + 60 giây.
 * Không xoá bản ghi, không đụng file trên ổ.
 *
 * Dùng:
 *   node scripts/fix-runaway-segment-durations.mjs           # chỉ xem
 *   node scripts/fix-runaway-segment-durations.mjs --apply   # ghi thật
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG_NAME = "Đại Kim";
/** Máy kho cắt 60 giây một đoạn; dài quá ngưỡng này là hỏng dữ liệu. */
const MAX_REASONABLE_SECONDS = 5 * 60;
const SEGMENT_SECONDS = 60;

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
  console.log(`Kho: ${org.name}`);

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("camera_recording_files")
      .select("id, file_path, started_at, ended_at, duration_seconds")
      .eq("organization_id", org.id)
      .eq("source", "agent")
      .gt("duration_seconds", MAX_REASONABLE_SECONDS)
      .order("started_at")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  console.log(`\nĐoạn dài quá ${MAX_REASONABLE_SECONDS / 60} phút: ${rows.length}`);
  for (const r of rows.slice(0, 8)) {
    const ngay = Math.round((r.duration_seconds ?? 0) / 86400);
    console.log(
      `  ${r.file_path}  dài ${r.duration_seconds}s${ngay >= 1 ? ` (~${ngay} ngày)` : ""}`,
    );
  }
  if (rows.length > 8) console.log(`  ... và ${rows.length - 8} đoạn nữa`);

  if (!APPLY) {
    console.log(`\n(chỉ xem — chạy lại với --apply để ghi thật)`);
    return;
  }

  let xong = 0;
  for (const r of rows) {
    const ketThuc = new Date(new Date(r.started_at).getTime() + SEGMENT_SECONDS * 1000).toISOString();
    const { error } = await db
      .from("camera_recording_files")
      .update({ ended_at: ketThuc, duration_seconds: SEGMENT_SECONDS })
      .eq("id", r.id);
    if (error) throw new Error(`Bản ghi ${r.id}: ${error.message}`);
    xong += 1;
  }
  console.log(`\nĐã cắt ngắn ${xong} đoạn về ${SEGMENT_SECONDS} giây.`);
}

void main();
