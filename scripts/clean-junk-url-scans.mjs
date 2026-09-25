/**
 * Dọn các lượt quét có mã KHÔNG phải mã vận đơn (sự cố kho Đại Kim
 * 25/09/2026).
 *
 * Hai nhóm:
 *   1. Mã đường link. Nhãn TikTok in hai mã QR — mã vận đơn và một mã link
 *      tới trang shop. Camera bắt trúng cái link: 27/08 tạo một "đơn đi"
 *      với mã là cả cái URL, rồi từ đó mỗi lần cái nhãn lọt vào khung là
 *      lưới an toàn lại thấy "mã đã gửi đi bị quét lại" và ghi thành một
 *      KIỆN HOÀN 0 giây, nằm lẫn trong nhật ký đóng hàng.
 *   2. Mã camera đọc hụt, còn lại một hai ký tự ("7", "8", "9", "5858",
 *      "S") và một mảnh GUID. Nhóm này nằm trong luồng đóng hàng với trạng
 *      thái `valid`.
 *
 * Nguyên nhân đã chặn ở 20260925120000 + 20260925130000. Script này dọn
 * phần đã lỡ sinh ra, vì chúng đang tính vào báo cáo và vào số kiện hoàn.
 *
 * Diện xoá dùng đúng luật `is_waybill_like` đang chạy trên database, nên
 * đơn thật không bao giờ lọt vào. Chủ dự án chốt 25/09/2026: xoá hẳn cả
 * hai nhóm, không để mã sai nằm trong số liệu. Xoá xong số đơn đóng hàng
 * của các ngày dính nhóm 2 sẽ giảm — đúng ý, vì chúng vốn không phải đơn.
 *
 * Dùng:
 *   node scripts/clean-junk-url-scans.mjs           # chỉ xem
 *   node scripts/clean-junk-url-scans.mjs --apply   # xoá thật
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
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

/** Cùng luật với hàm is_waybill_like trên database. */
const coDangMaVanDon = (v) =>
  typeof v === "string" && v.length >= 8 && v.length <= 40 && /^[A-Z0-9][A-Z0-9._-]*$/.test(v);

/** Tách nhóm chỉ để in ra cho dễ soát; cả hai nhóm đều bị xoá. */
const laDuongLink = (v) => /^HTTPS?:\/\//i.test(v ?? "");

function tomTat(ds) {
  const m = new Map();
  for (const e of ds) {
    const k = e.waybill_code ?? "(rỗng)";
    const s = m.get(k) ?? {
      tong: 0,
      tt: new Map(),
      loai: new Map(),
      dau: e.scanned_at,
      cuoi: e.scanned_at,
    };
    s.tong += 1;
    s.tt.set(e.status, (s.tt.get(e.status) ?? 0) + 1);
    s.loai.set(e.event_kind, (s.loai.get(e.event_kind) ?? 0) + 1);
    s.cuoi = e.scanned_at;
    m.set(k, s);
  }
  for (const [ma, s] of m) {
    const tt = [...s.tt].map(([k, v]) => k + "×" + v).join(", ");
    const loai = [...s.loai].map(([k, v]) => k + "×" + v).join(", ");
    console.log(`\n  "${ma.slice(0, 50)}" — ${s.tong} lượt`);
    console.log(`    trạng thái: ${tt}`);
    console.log(`    luồng     : ${loai}`);
    console.log(`    ${String(s.dau).slice(0, 19)} → ${String(s.cuoi).slice(0, 19)}`);
  }
}

async function main() {
  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .ilike("name", `%${ORG_NAME}%`)
    .single();
  console.log(`Kho: ${org.name}\n`);

  const events = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("packing_events")
      .select("id, waybill_code, status, event_kind, scanned_at, order_id, work_duration_seconds")
      .eq("organization_id", org.id)
      .order("scanned_at")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    events.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const canXoa = events.filter((e) => !coDangMaVanDon(e.waybill_code ?? ""));
  const nhomLink = canXoa.filter((e) => laDuongLink(e.waybill_code));
  const nhomDocHut = canXoa.filter((e) => !laDuongLink(e.waybill_code));

  console.log(`Lượt quét mã sai: ${canXoa.length}/${events.length}`);
  console.log(`  - mã đường link    : ${nhomLink.length}`);
  console.log(`  - mã camera đọc hụt: ${nhomDocHut.length}`);

  console.log(`\n=== MÃ ĐƯỜNG LINK ===`);
  tomTat(nhomLink);
  console.log(`\n=== MÃ CAMERA ĐỌC HỤT ===`);
  tomTat(nhomDocHut);

  if (canXoa.length === 0) {
    await donLuotQuetTho(org.id);
    return;
  }

  const ids = canXoa.map((e) => e.id);
  const clips = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await db
      .from("order_proof_clips")
      .select("id")
      .in("packing_event_id", ids.slice(i, i + 50));
    clips.push(...(data ?? []));
  }
  console.log(`\nClip bằng chứng dính tới các lượt sẽ xoá: ${clips.length}`);

  if (!APPLY) {
    await donLuotQuetTho(org.id);
    console.log(`\n(chỉ xem — chạy lại với --apply để xoá thật)`);
    return;
  }

  if (clips.length > 0) {
    for (let i = 0; i < ids.length; i += 50) {
      const { error } = await db
        .from("order_proof_clips")
        .delete()
        .in("packing_event_id", ids.slice(i, i + 50));
      if (error) throw new Error(`Xoá clip: ${error.message}`);
    }
    console.log(`Đã xoá ${clips.length} clip.`);
  }

  for (let i = 0; i < ids.length; i += 50) {
    const { error } = await db.from("packing_events").delete().in("id", ids.slice(i, i + 50));
    if (error) throw new Error(`Xoá lượt quét: ${error.message}`);
  }
  console.log(`Đã xoá ${ids.length} lượt quét.`);

  // Đơn trong bảng orders sinh ra từ mã sai — chỉ xoá khi không còn lượt
  // quét nào trỏ tới.
  const orderIds = [...new Set(canXoa.map((e) => e.order_id).filter(Boolean))];
  let xoaOrder = 0;
  for (const oid of orderIds) {
    const { count } = await db
      .from("packing_events")
      .select("id", { count: "exact", head: true })
      .eq("order_id", oid);
    if ((count ?? 0) > 0) continue;
    const { error } = await db.from("orders").delete().eq("id", oid);
    if (!error) xoaOrder += 1;
  }
  console.log(`Đã xoá ${xoaOrder} đơn trong bảng orders.`);

  await donLuotQuetTho(org.id);
}

/**
 * Lượt quét thô (`warehouse_scan_raw_events`) là bản ghi TRƯỚC khi hệ
 * thống phân loại. Xoá đơn mà để lại lượt thô thì nhật ký vẫn còn dòng —
 * hiện là "Đang chờ xử lý", nhìn còn khó hiểu hơn "Mã sai".
 *
 * Chỉ đụng `scan_type = 'waybill'`: QR nhân viên và thẻ điều khiển có cấu
 * trúc riêng, đem luật mã vận đơn ra đo là xoá nhầm sạch.
 */
async function donLuotQuetTho(orgId) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("warehouse_scan_raw_events")
      .select("id, raw_value, scan_type, scanned_at")
      .eq("organization_id", orgId)
      .eq("scan_type", "waybill")
      .order("scanned_at")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const rac = rows.filter((r) => !coDangMaVanDon((r.raw_value ?? "").trim().toUpperCase()));
  console.log(`
Lượt quét THÔ mã sai: ${rac.length}/${rows.length}`);
  const theoMa = new Map();
  for (const r of rac) theoMa.set(r.raw_value, (theoMa.get(r.raw_value) ?? 0) + 1);
  for (const [ma, n] of theoMa) console.log(`  "${String(ma).slice(0, 50)}" — ${n} lượt`);

  if (rac.length === 0 || !APPLY) {
    if (rac.length > 0) console.log(`  (chỉ xem)`);
    return;
  }

  const ids = rac.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 50) {
    const { error } = await db
      .from("warehouse_scan_raw_events")
      .delete()
      .in("id", ids.slice(i, i + 50));
    if (error) throw new Error(`Xoá lượt quét thô: ${error.message}`);
  }
  console.log(`Đã xoá ${ids.length} lượt quét thô.`);
}

void main();
