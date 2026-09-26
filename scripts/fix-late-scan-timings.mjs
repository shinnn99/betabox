/**
 * Sửa thời gian đóng đơn bị ghi SAI vì lượt quét tới muộn (kho Đại Kim,
 * sáng 26/09/2026) — và, nếu chọn, xoá các dòng "Mã sai" thực ra là quét lại
 * một mã đã có đơn.
 *
 * VÌ SAO: lượt quét camera tới cloud chậm 1–3 phút và ngược thứ tự (đường
 * lên của kho bị việc tải clip chiếm hết). Hàm cũ đóng "đơn đang mở của bàn"
 * bằng giờ quét của mã vừa tới → thời lượng ÂM (−25s, −44s) và clip chồng lên
 * nhau. Migration 20260926140000 chặn cho lượt quét về sau; script này sửa
 * phần đã ghi sai. Luật sửa ở scripts/lib/late-scan-repair.mjs (có test).
 *
 * Nhóm "Mã sai / Đang chờ xử lý": nhân viên quét lại bằng súng ở bàn đặt
 * nguồn camera — mã đã có đơn. Chủ dự án chốt 26/09/2026: "mã trùng thì báo
 * mã trùng rồi không lưu". Route mới không lưu nữa; `--drop-duplicate-orphans`
 * xoá các dòng cũ. Chỉ xoá lượt quét thô KHÔNG sinh đơn nào VÀ mã đã có đơn đi
 * trong cùng ngày — đơn thật không bao giờ lọt vào.
 *
 * Dùng (ngày theo giờ Việt Nam):
 *   node scripts/fix-late-scan-timings.mjs --date 2026-09-26                 # chỉ xem
 *   node scripts/fix-late-scan-timings.mjs --date 2026-09-26 --apply         # sửa thời gian
 *   node scripts/fix-late-scan-timings.mjs --date 2026-09-26 --apply --drop-duplicate-orphans
 *   thêm --org <uuid> để chỉ chạy một tổ chức.
 *
 * Clip đã cắt theo cửa sổ cũ của các đơn được sửa sẽ được liệt kê — mở đơn đó
 * và bấm "Tạo lại" để cắt theo cửa sổ đúng.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { planTimingRepair } from "./lib/late-scan-repair.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DROP_DUP = args.includes("--drop-duplicate-orphans");
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const DATE = argValue("--date");
const ORG = argValue("--org");
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error("Thiếu --date YYYY-MM-DD (ngày theo giờ Việt Nam).");
  process.exit(1);
}

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

// Ngày giờ Việt Nam (UTC+7) → khoảng UTC.
const startIso = new Date(Date.parse(`${DATE}T00:00:00+07:00`)).toISOString();
const endIso = new Date(Date.parse(`${DATE}T00:00:00+07:00`) + 86_400_000).toISOString();
const vn = (iso) => (iso ? new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(11, 19) : "—");

let q = db
  .from("packing_events")
  .select(
    "id, organization_id, station_id, warehouse_id, waybill_code, scanned_at, work_started_at, work_ended_at, work_duration_seconds, timing_status, closed_by_packing_event_id",
  )
  .eq("event_kind", "outbound")
  .eq("status", "valid")
  .gte("scanned_at", startIso)
  .lt("scanned_at", endIso)
  .order("scanned_at");
if (ORG) q = q.eq("organization_id", ORG);
const { data: events, error } = await q;
if (error) {
  console.error("Đọc đơn lỗi:", error.message);
  process.exit(1);
}

const byStation = new Map();
for (const e of events ?? []) {
  if (!e.station_id) continue;
  byStation.set(e.station_id, [...(byStation.get(e.station_id) ?? []), e]);
}

const maxByWarehouse = new Map();
async function maxFor(warehouseId) {
  if (maxByWarehouse.has(warehouseId)) return maxByWarehouse.get(warehouseId);
  const { data } = await db.rpc("resolve_packing_timing", { p_warehouse_id: warehouseId });
  const max = Number(data?.max_order_seconds) || 180;
  maxByWarehouse.set(warehouseId, max);
  return max;
}

const allFixes = [];
for (const [stationId, list] of byStation) {
  const max = await maxFor(list[0].warehouse_id);
  const fixes = planTimingRepair(list, max);
  if (fixes.length === 0) continue;
  console.log(`\n== Bàn ${stationId} (trần ${max}s): ${fixes.length} đơn cần sửa ==`);
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const f of fixes) {
    const e = byId.get(f.id);
    console.log(
      `  ${e.waybill_code}  bắt đầu ${vn(e.work_started_at ?? e.scanned_at)}  ` +
        `kết thúc ${vn(f.before.work_ended_at)} (${f.before.work_duration_seconds}s, ${f.before.timing_status}) → ` +
        `${vn(f.after.work_ended_at)} (${f.after.work_duration_seconds}s, ${f.after.timing_status})`,
    );
  }
  allFixes.push(...fixes);
}
console.log(`\nTổng: ${allFixes.length} đơn cần sửa thời gian.`);

if (allFixes.length > 0) {
  const { data: clips } = await db
    .from("order_proof_clips")
    .select("packing_event_id, status")
    .in(
      "packing_event_id",
      allFixes.map((f) => f.id),
    )
    .eq("status", "ready");
  if ((clips ?? []).length > 0) {
    console.log(`\n${clips.length} đơn đã có clip cắt theo cửa sổ CŨ — sau khi sửa, mở từng đơn và bấm "Tạo lại":`);
    const code = new Map((events ?? []).map((e) => [e.id, e.waybill_code]));
    for (const c of clips) console.log(`  ${code.get(c.packing_event_id) ?? c.packing_event_id}`);
  }
}

// Lượt quét lại một mã đã có đơn (dòng "Mã sai / Đang chờ xử lý").
let dupOrphans = [];
if (DROP_DUP) {
  let rq = db
    .from("warehouse_scan_raw_events")
    .select("id, organization_id, raw_value, scanned_at")
    .eq("scan_type", "waybill")
    .gte("scanned_at", startIso)
    .lt("scanned_at", endIso);
  if (ORG) rq = rq.eq("organization_id", ORG);
  const { data: raws, error: rawErr } = await rq;
  if (rawErr) {
    console.error("Đọc lượt quét thô lỗi:", rawErr.message);
    process.exit(1);
  }
  const rawIds = (raws ?? []).map((r) => r.id);
  const withEvent = new Set();
  for (let i = 0; i < rawIds.length; i += 200) {
    const { data: pe } = await db.from("packing_events").select("raw_event_id").in("raw_event_id", rawIds.slice(i, i + 200));
    for (const p of pe ?? []) withEvent.add(p.raw_event_id);
  }
  const ordered = new Set((events ?? []).map((e) => `${e.organization_id}|${e.waybill_code}`));
  dupOrphans = (raws ?? []).filter(
    (r) => !withEvent.has(r.id) && ordered.has(`${r.organization_id}|${String(r.raw_value).trim().toUpperCase()}`),
  );
  console.log(`\n${dupOrphans.length} lượt quét lại mã đã có đơn (dòng "Mã sai" / "Đang chờ xử lý") sẽ bị xoá:`);
  for (const r of dupOrphans) console.log(`  ${vn(r.scanned_at)}  ${r.raw_value}`);
}

if (!APPLY) {
  console.log("\nChỉ xem. Thêm --apply để sửa thật.");
  process.exit(0);
}

let ok = 0;
for (const f of allFixes) {
  const { error: upErr } = await db.from("packing_events").update(f.after).eq("id", f.id);
  if (upErr) console.error(`  Sửa ${f.id} lỗi: ${upErr.message}`);
  else ok++;
}
console.log(`\nĐã sửa ${ok}/${allFixes.length} đơn.`);

if (DROP_DUP && dupOrphans.length > 0) {
  const ids = dupOrphans.map((r) => r.id);
  const { error: delErr, count } = await db.from("warehouse_scan_raw_events").delete({ count: "exact" }).in("id", ids);
  if (delErr) console.error(`Xoá lượt quét lỗi: ${delErr.message}`);
  else console.log(`Đã xoá ${count ?? ids.length} lượt quét lại mã đã có đơn.`);
}
