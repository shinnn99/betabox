/**
 * Điền giờ kết thúc cho các đoạn video máy kho quét được từ ổ đĩa
 * (sự cố kho Đại Kim 25/09/2026).
 *
 * Khi chủ kho chép đoạn video sang thư mục khác, máy kho quét ổ và tạo
 * bản ghi mới — nhưng chỉ đọc được GIỜ BẮT ĐẦU từ tên file. Giờ kết thúc
 * và độ dài để trống, vì muốn biết thì phải mở từng file ra đo.
 *
 * Hậu quả: phần tìm đoạn để cắt clip coi bản ghi thiếu giờ kết thúc là
 * "đoạn đang ghi dở", nên vơ hết mọi đoạn cũ vào cửa sổ cần cắt — đo được
 * 1.000 đoạn cho một đơn chỉ cần 21 đoạn, và đoạn đầu tiên lệch tới 3
 * tuần.
 *
 * Cách điền: giờ kết thúc = giờ bắt đầu của đoạn KẾ TIẾP nếu nó cách dưới
 * 2 phút; không thì lấy đúng 60 giây (máy kho cắt đoạn 60 giây một, xem
 * `-segment_time` trong recording.ts). Không mở file, không cần máy kho.
 *
 * Dùng:
 *   node scripts/fix-scanned-segment-times.mjs           # chỉ xem
 *   node scripts/fix-scanned-segment-times.mjs --apply   # ghi thật
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG_NAME = "Đại Kim";
/**
 * Để `null` là xử mọi camera. Đặt tên camera nếu muốn giới hạn.
 *
 * Camera đang chạy cũng có đoạn thiếu giờ kết thúc, nhưng đó là đoạn ĐANG
 * GHI DỞ, hoàn toàn bình thường — máy kho sẽ điền khi đóng đoạn. Chốt
 * chặn là mốc thời gian bên dưới, không phải danh sách camera: đoạn cũ
 * hơn nửa tiếng mà vẫn trống giờ kết thúc thì chắc chắn không còn ai ghi.
 *
 * Bỏ sót nhóm này thì đoạn cũ bị coi là "đang ghi dở" và lọt vào MỌI cửa
 * sổ cắt clip về sau — đo được ở kho Đại Kim: đơn ngày 24/09 vớ phải đoạn
 * ngày 17/09, ghép ra file hỏng, báo `unsupported_output_codec`.
 */
const ONLY_CAMERA = null;
/** Không đụng đoạn mới hơn ngần này — gần như chắc chắn đang ghi dở. */
const SKIP_NEWER_THAN_MINUTES = 30;
/** Đoạn ghi mặc định của máy kho. */
const SEGMENT_SECONDS = 60;
/** Cách nhau quá ngưỡng này thì không coi là hai đoạn liền nhau. */
const MAX_GAP_SECONDS = 120;

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

const ghi = async (id, patch) => {
  for (let lan = 1; lan <= 4; lan += 1) {
    const { error } = await db.from("camera_recording_files").update(patch).eq("id", id);
    if (!error) return;
    if (lan === 4) throw new Error(`Bản ghi ${id}: ${error.message}`);
    await new Promise((tiep) => setTimeout(tiep, 500 * lan));
  }
};

async function main() {
  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .ilike("name", `%${ORG_NAME}%`)
    .single();
  console.log(`Kho: ${org.name}`);

  // Đọc TOÀN BỘ đoạn của mỗi camera để biết đoạn kế tiếp là đoạn nào.
  const { data: cams } = await db
    .from("cameras")
    .select("id, camera_code")
    .eq("organization_id", org.id);

  let tongThieu = 0;
  const viec = [];
  const nguong = Date.now() - SKIP_NEWER_THAN_MINUTES * 60 * 1000;
  const danhSach = ONLY_CAMERA ? (cams ?? []).filter((c) => c.camera_code === ONLY_CAMERA) : (cams ?? []);
  for (const cam of danhSach) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("camera_recording_files")
        .select("id, started_at, ended_at, duration_seconds")
        .eq("organization_id", org.id)
        .eq("camera_id", cam.id)
        .eq("source", "agent")
        .order("started_at")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const thieu = rows.filter((r) => !r.ended_at);
    if (thieu.length === 0) continue;
    tongThieu += thieu.length;
    console.log(`  ${cam.camera_code}: ${thieu.length}/${rows.length} đoạn thiếu giờ kết thúc`);

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (r.ended_at) continue;
      if (new Date(r.started_at).getTime() > nguong) continue;
      const batDau = new Date(r.started_at).getTime();
      const ke = rows[i + 1];
      let dai = SEGMENT_SECONDS;
      if (ke) {
        const cach = (new Date(ke.started_at).getTime() - batDau) / 1000;
        if (cach > 0 && cach <= MAX_GAP_SECONDS) dai = Math.round(cach);
      }
      viec.push({
        id: r.id,
        patch: {
          ended_at: new Date(batDau + dai * 1000).toISOString(),
          duration_seconds: dai,
        },
      });
    }
  }

  console.log(`\nTổng cần điền: ${tongThieu} đoạn`);
  if (viec[0]) {
    console.log(`Ví dụ: kết thúc=${viec[0].patch.ended_at.slice(0, 19)} dài=${viec[0].patch.duration_seconds}s`);
  }
  if (!APPLY) {
    console.log(`\n(chỉ xem — chạy lại với --apply để ghi thật)`);
    return;
  }

  let xong = 0;
  const LO = 12;
  for (let i = 0; i < viec.length; i += LO) {
    await Promise.all(viec.slice(i, i + LO).map((v) => ghi(v.id, v.patch)));
    xong += Math.min(LO, viec.length - i);
    if (i > 0 && i % (LO * 50) === 0) console.log(`  ... ${xong}/${viec.length}`);
  }
  console.log(`\nĐã điền ${xong} đoạn.`);
}

void main();
