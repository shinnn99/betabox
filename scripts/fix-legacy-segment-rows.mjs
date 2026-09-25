/**
 * Cho cắt lại được clip của đơn CŨ sau khi đoạn video bị chuyển thư mục
 * (sự cố kho Đại Kim 25/09/2026).
 *
 * Chuyện đã xảy ra:
 *   - Tới 21/09, kho ghi hình bằng camera `dahua_01`, file nằm ở
 *     `dahua_01/2026/09/17/...`.
 *   - Chủ kho chép toàn bộ đoạn video 30 ngày gần nhất sang thư mục
 *     `CTC01/`, giữ nguyên tên file, rồi bỏ thư mục cũ.
 *   - Máy kho quét ổ đĩa, thấy file trong `CTC01/` và tạo bản ghi MỚI,
 *     gán cho camera `CTC01` (nó suy camera từ tên thư mục).
 *
 * Kết quả: mỗi file có HAI bản ghi.
 *   bản cũ : camera=dahua_01, đường dẫn `dahua_01/...`  → file không còn ở đó
 *   bản mới: camera=CTC01,    đường dẫn `CTC01/...`     → file có thật
 *
 * Đơn hàng cũ ghi "camera lúc quét = dahua_01", nên hệ thống chỉ tìm thấy
 * bản CŨ — đường dẫn hỏng. Bản tốt lại mang tên camera khác. Không clip
 * nào của đơn trước 22/09 cắt lại được.
 *
 * Script sửa hai việc, KHÔNG XOÁ BẢN GHI NÀO:
 *   1. Bản MỚI: đổi camera về `dahua_01` — đúng sự thật, vì đoạn video đó
 *      do camera dahua_01 ghi, chỉ là giờ nằm trong thư mục CTC01.
 *   2. Bản CŨ: đổi `source` sang `legacy_nextjs` để đường cắt clip bỏ qua
 *      (đường đó chỉ đọc `source = 'agent'`). Đúng nghĩa cột này: bản ghi
 *      trỏ tới file không có trên ổ của máy kho. Bản ghi vẫn còn nguyên,
 *      đổi lại được bất cứ lúc nào.
 *
 * Dùng:
 *   node scripts/fix-legacy-segment-rows.mjs           # chỉ xem
 *   node scripts/fix-legacy-segment-rows.mjs --apply   # ghi thật
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const ORG_NAME = "Đại Kim";
/** Chủ dự án chốt 25/09/2026: chỉ xử lý trong 30 ngày gần nhất. */
const SCOPE_DAYS = 30;
const SCOPE_FROM = new Date(Date.now() - SCOPE_DAYS * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
/** Từ ngày này trở đi bản ghi vốn đã đúng — không đụng tới. */
const HEALTHY_FROM = "2026-09-22";
const OLD_CAMERA = "dahua_01";
const NEW_FOLDER = "CTC01/";

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

const doc = async (build) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(
      db.from("camera_recording_files").select("id, camera_id, agent_id, file_path, source, started_at"),
    )
      .order("started_at")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
};

/** Ghi có thử lại: mạng từ máy lập trình ra Supabase có lúc đứt. */
const ghi = async (id, patch) => {
  for (let lan = 1; lan <= 4; lan += 1) {
    const { error } = await db.from("camera_recording_files").update(patch).eq("id", id);
    if (!error) return;
    if (lan === 4) throw new Error(`Bản ghi ${id}: ${error.message}`);
    await new Promise((tiep) => setTimeout(tiep, 500 * lan));
  }
};

const chayTheoLo = async (rows, patchOf, nhan) => {
  let xong = 0;
  const LO = 12;
  for (let i = 0; i < rows.length; i += LO) {
    await Promise.all(rows.slice(i, i + LO).map((r) => ghi(r.id, patchOf(r))));
    xong += Math.min(LO, rows.length - i);
    if (i > 0 && i % (LO * 50) === 0) console.log(`  ... ${nhan}: ${xong}/${rows.length}`);
  }
  return xong;
};

async function main() {
  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .ilike("name", `%${ORG_NAME}%`)
    .single();
  const { data: cams } = await db
    .from("cameras")
    .select("id, camera_code")
    .eq("organization_id", org.id);
  const cameraCu = (cams ?? []).find((c) => c.camera_code === OLD_CAMERA);
  if (!cameraCu) throw new Error(`Không thấy camera ${OLD_CAMERA} trong kho`);

  console.log(`Kho: ${org.name}`);
  console.log(`Phạm vi: ${SCOPE_FROM} → trước ${HEALTHY_FROM}\n`);

  const trongPhamVi = (q) =>
    q.eq("organization_id", org.id).gte("started_at", SCOPE_FROM).lt("started_at", HEALTHY_FROM);

  // (1) Bản MỚI: file dahua_01_* nằm trong thư mục CTC01, đang gán nhầm camera.
  const banMoi = (
    await doc((q) => trongPhamVi(q).like("file_path", `${NEW_FOLDER}%`).like("file_name", `${OLD_CAMERA}_%`))
  ).filter((r) => r.camera_id !== cameraCu.id);

  // (2) Bản CŨ: trỏ thư mục cũ, file không còn ở đó.
  const banCu = (
    await doc((q) => trongPhamVi(q).like("file_path", `${OLD_CAMERA}/%`))
  ).filter((r) => r.source === "agent");

  console.log(`(1) bản ghi MỚI cần đổi camera về ${OLD_CAMERA}: ${banMoi.length}`);
  console.log(`(2) bản ghi CŨ cần đánh dấu bỏ qua              : ${banCu.length}`);
  if (banMoi[0]) console.log(`\n    ví dụ (1): ${banMoi[0].file_path}`);
  if (banCu[0]) console.log(`    ví dụ (2): ${banCu[0].file_path}`);

  if (!APPLY) {
    console.log(`\n(chỉ xem — chạy lại với --apply để ghi thật)`);
    return;
  }

  const a = await chayTheoLo(banMoi, () => ({ camera_id: cameraCu.id }), "đổi camera");
  console.log(`Đã đổi camera cho ${a} bản ghi.`);
  const b = await chayTheoLo(banCu, () => ({ source: "legacy_nextjs" }), "đánh dấu bỏ qua");
  console.log(`Đã đánh dấu bỏ qua ${b} bản ghi cũ.`);

  const { count: conLech } = await trongPhamVi(
    db.from("camera_recording_files").select("id", { count: "exact", head: true }),
  )
    .eq("source", "agent")
    .like("file_path", `${OLD_CAMERA}/%`);
  console.log(`\nKiểm lại: còn ${conLech} bản ghi hỏng chưa đánh dấu.`);
}

void main();
