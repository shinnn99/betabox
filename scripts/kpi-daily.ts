#!/usr/bin/env node
/**
 * BB-1 / BB-2 / BB-3 — tính từ dữ liệu thật, không cần cột mới.
 *
 *   BB-1  Số ngày-kho đạt chuẩn Betabox        (ngày-kho, cao hơn tốt)
 *   BB-2  Số đơn mất hoàn toàn bằng chứng      (đơn,      thấp hơn tốt)
 *   BB-3  Bàn-phút mất khả năng ghi bằng chứng (bàn-phút, thấp hơn tốt)
 *
 * VÌ SAO DỰNG LẠI ĐƯỢC QUÁ KHỨ: `camera_recording_files` không bị xoá
 * dòng khi file hết hạn lưu trữ — không script nào xoá, và chính
 * clip-resolver phải SUY ra "hết hạn" bằng cách tìm dòng cũ hơn retention
 * (clip-resolver.ts:551-566). Dòng segment vì thế là bằng chứng cho câu
 * hỏi "lúc đóng đơn có ghi được không", kể cả khi file trên ổ đã bị dọn.
 * Đó là câu hỏi của BB-2, nên chạy lại sổ cho 12 tuần trước là hợp lệ.
 * File bị dọn theo retention KHÔNG tính là mất bằng chứng — đó là chính
 * sách đã thoả thuận với khách, không phải hỏng hóc.
 *
 * BA QUY TẮC TRIỂN KHAI ĐÃ CHỐT, hiện thực ở đúng các chỗ đánh dấu:
 *   1. Khoá ngày là `business_date` (ngày UTC). KHÔNG chia lại theo giờ
 *      VN ở bất cứ chỉ số nào — nếu không BB-1/2/3 sẽ nói về ba tập ngày
 *      khác nhau cho đơn quét trong khoảng 00:00–07:00 giờ VN.
 *   2. Tập bàn của BB-1 và BB-3 là MỘT: bàn có segment trong ngày, HOẶC
 *      được `proof_camera_id` của một đơn hợp lệ trỏ tới. Vế thứ hai là
 *      thứ chặn ca "agent chết cả ngày → không bàn nào đủ điều kiện →
 *      BB-3 = 0" — ngày mù nhất tuần mà hiện đẹp nhất.
 *   3. Ngày chưa qua 24 giờ bị đánh dấu CHƯA CHỐT, không đưa vào tổng
 *      tuần: agent quét bù segment còn thiếu khi khởi động (cửa sổ mặc
 *      định 30 ngày, warehouse-agent/src/config.ts:90), nên số đo sớm
 *      luôn thổi phồng phút mất rồi tự co lại.
 *
 * Chạy (từ gốc repo, cần .env.local có SUPABASE_SERVICE_ROLE_KEY):
 *   node --experimental-strip-types scripts/kpi-daily.ts
 *   node --experimental-strip-types scripts/kpi-daily.ts --weeks=12
 *   node --experimental-strip-types scripts/kpi-daily.ts --from=2026-08-01 --to=2026-08-14
 *   node --experimental-strip-types scripts/kpi-daily.ts --csv > kpi.csv
 *
 * CHỈ ĐỌC. Không câu lệnh ghi nào trong file này.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  cameraGapMinutes,
  coverageOfWindow,
  warehouseHoursFromScans,
  type SegmentLike,
} from "../src/lib/system/evidence-coverage.ts";

// ============================================================================
// Tham số
// ============================================================================

/** Ngưỡng BB-1, co giãn theo số bàn tham gia ghi bằng chứng trong ngày. */
const BB1_BAN_PHUT_MOI_BAN = 5;

/** Ngày mới hơn ngần này chưa chốt số — chờ agent quét bù. */
const CHUA_CHOT_GIO = 24;

/**
 * Dòng segment còn mở (`ended_at IS NULL`) mà đã cũ hơn ngần này thì coi
 * là ffmpeg chết bỏ lại, không phải đang ghi.
 *
 * Vì sao phải xử: `coverageOfWindow` trả "defer" khi gặp segment mở, và
 * đúng như vậy cho đơn vừa đóng. Nhưng một dòng mở từ tháng trước sẽ làm
 * MỌI đơn của camera đó treo "defer" vĩnh viễn. Với dòng cũ, ta đóng nó
 * bằng `duration_seconds` mà agent đã ghi (rơi về 60 giây — độ dài
 * segment do cloud quyết định trong active-credentials.ts).
 */
const SEGMENT_MO_QUA_HAN_GIO = 24;
const SEGMENT_MAC_DINH_GIAY = 60;

const args = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const asCsv = args.includes("--csv");
const orgFilter = argOf("org");
const weeks = Number(argOf("weeks") ?? 12);
/**
 * Mặc định chỉ tính tổ chức đang bật theo dõi — CÙNG cửa lọc mà self-check
 * dùng (checks.ts: loadMonitoringScope).
 *
 * Vì sao bắt buộc: `AGENT_KHO_HN_01` là agent DEMO chạy trên máy dev
 * Betacom, cùng bảng với agent production. Không lọc thì "Kho Betacom Demo"
 * đi thẳng vào BB-1/BB-2/BB-3 — số của một cái laptop gập mở tuỳ hứng nằm
 * chung sổ với số cam kết cho khách. `--all` để soi khi cần.
 */
const includeAll = args.includes("--all");

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const today = new Date();
const toDate = argOf("to") ?? isoDate(today);
const fromDate =
  argOf("from") ??
  isoDate(new Date(today.getTime() - weeks * 7 * 86_400_000));

// ============================================================================
// Kết nối
// ============================================================================

const envRaw = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envRaw.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env.local");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

/**
 * Kéo hết bảng theo trang 1000 dòng.
 *
 * PostgREST trần 1000 dòng mỗi request và KHÔNG báo lỗi khi chạm trần —
 * nó trả đúng 1000 dòng như thể đó là toàn bộ. Một camera ghi 12 tiếng
 * mỗi ngày đã là ~720 segment/ngày, nên không phân trang thì mọi con số
 * ở đây sai theo hướng "trông sạch hơn thực tế".
 */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// ============================================================================
// Dữ liệu
// ============================================================================

interface OrderRow {
  id: string;
  organization_id: string;
  warehouse_id: string | null;
  business_date: string;
  scanned_at: string;
  work_started_at: string | null;
  work_duration_seconds: number | null;
  proof_camera_id: string | null;
}

interface SegmentRow {
  camera_id: string;
  organization_id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

console.error(`Đang đọc dữ liệu ${fromDate} → ${toDate}${orgFilter ? ` (org ${orgFilter})` : ""}…`);

/** Tổ chức trong phạm vi sổ. null = không giới hạn (--all). */
let scopeOrgIds: string[] | null = null;
if (!includeAll) {
  const { data, error } = await db
    .from("organizations")
    .select("id, name")
    .eq("monitoring_enabled", true);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
  scopeOrgIds = rows.map((r) => r.id);
  console.error(
    `  phạm vi: ${rows.length} tổ chức bật theo dõi (${rows.map((r) => r.name ?? r.id.slice(0, 8)).join(", ") || "không có"})`,
  );
  if (scopeOrgIds.length === 0) {
    console.error("  Không tổ chức nào bật monitoring_enabled — không có gì để tính. Dùng --all để bỏ cửa lọc.");
    process.exit(0);
  }
}
const inScope = <T extends { in: (col: string, v: string[]) => T; eq: (col: string, v: string) => T }>(q: T): T => {
  if (orgFilter) return q.eq("organization_id", orgFilter);
  return scopeOrgIds ? q.in("organization_id", scopeOrgIds) : q;
};

const orders = await fetchAll<OrderRow>((from, to) => {
  const q = db
    .from("packing_events")
    .select(
      "id, organization_id, warehouse_id, business_date, scanned_at, work_started_at, work_duration_seconds, proof_camera_id",
    )
    // Đơn hợp lệ và đã kết thúc đóng hàng — đúng mẫu số đã chốt. Quét
    // trùng (`duplicated`) không phải một đơn, tính vào thì một lần bấm
    // nhầm thành một "đơn mất bằng chứng".
    .eq("status", "valid")
    .neq("timing_status", "open")
    .gte("business_date", fromDate)
    .lte("business_date", toDate)
    .order("scanned_at", { ascending: true })
    .range(from, to);
  return inScope(q);
});

// Nới hai đầu một ngày: segment phủ đơn đầu/cuối ngày có thể bắt đầu từ
// hôm trước hoặc kết thúc sang hôm sau.
const segFrom = new Date(`${fromDate}T00:00:00.000Z`).getTime() - 86_400_000;
const segTo = new Date(`${toDate}T00:00:00.000Z`).getTime() + 2 * 86_400_000;

const segments = await fetchAll<SegmentRow>((from, to) => {
  const q = db
    .from("camera_recording_files")
    .select("camera_id, organization_id, started_at, ended_at, duration_seconds")
    // Chỉ dòng do agent ghi. Dòng của route Next.js cũ trỏ ổ máy khác nên
    // không chứng minh được gì về ổ đang ghi (clip-resolver.ts:509-514).
    .eq("source", "agent")
    .gte("started_at", new Date(segFrom).toISOString())
    .lt("started_at", new Date(segTo).toISOString())
    .order("started_at", { ascending: true })
    .range(from, to);
  return inScope(q);
});

console.error(`  ${orders.length} đơn hợp lệ · ${segments.length} segment`);

// ============================================================================
// Chuẩn hoá segment
// ============================================================================

const gioMo = SEGMENT_MO_QUA_HAN_GIO * 3_600_000;
const nowMs = Date.now();
let segmentMoDaDong = 0;

interface Seg extends SegmentLike {
  cameraId: string;
  startMs: number;
  endMs: number;
}

const segsByCamera = new Map<string, Seg[]>();
for (const s of segments) {
  const startMs = new Date(s.started_at).getTime();
  if (!Number.isFinite(startMs)) continue;

  let ended = s.ended_at;
  if (ended === null && nowMs - startMs > gioMo) {
    // Dòng mở đã quá hạn = ffmpeg chết bỏ lại. Đóng bằng độ dài agent ghi.
    const dur = s.duration_seconds ?? SEGMENT_MAC_DINH_GIAY;
    ended = new Date(startMs + dur * 1_000).toISOString();
    segmentMoDaDong += 1;
  }

  const list = segsByCamera.get(s.camera_id) ?? [];
  list.push({
    cameraId: s.camera_id,
    started_at: s.started_at,
    ended_at: ended,
    startMs,
    endMs: ended ? new Date(ended).getTime() : Number.POSITIVE_INFINITY,
  });
  segsByCamera.set(s.camera_id, list);
}
for (const list of segsByCamera.values()) list.sort((a, b) => a.startMs - b.startMs);

/**
 * Segment của một camera giao với [start, end].
 *
 * Nhị phân trên mảng đã sắp theo `startMs` rồi đi tới. Quét tuyến tính
 * cho mỗi đơn là O(số đơn × số segment) — với một kho ghi 12 tiếng và
 * hai nghìn đơn mỗi ngày thì đó là hàng trăm triệu phép so sánh cho một
 * câu hỏi có đáp án vài dòng.
 */
function segmentsOverlapping(cameraId: string, start: number, end: number): Seg[] {
  const list = segsByCamera.get(cameraId);
  if (!list || list.length === 0) return [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].endMs <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: Seg[] = [];
  for (let i = lo; i < list.length && list[i].startMs < end; i += 1) {
    if (list[i].endMs > start) out.push(list[i]);
  }
  return out;
}

// ============================================================================
// Gom theo ngày-kho
// ============================================================================

interface NgayKho {
  key: string;
  orgId: string;
  warehouseId: string;
  businessDate: string;
  orders: OrderRow[];
}

const ngayKhoMap = new Map<string, NgayKho>();
for (const o of orders) {
  // Đơn không gắn kho: gom về một nhóm riêng thay vì bỏ im lặng — bỏ thì
  // BB-2 thiếu đơn mà không ai biết.
  const warehouseId = o.warehouse_id ?? "(chưa gán kho)";
  const key = `${warehouseId}|${o.business_date}`;
  const cur = ngayKhoMap.get(key);
  if (cur) cur.orders.push(o);
  else
    ngayKhoMap.set(key, {
      key,
      orgId: o.organization_id,
      warehouseId,
      businessDate: o.business_date,
      orders: [o],
    });
}

/** Camera → kho, suy từ chính đơn của ngày hôm đó. */
const khoCuaCamera = new Map<string, Set<string>>();
for (const o of orders) {
  if (!o.proof_camera_id || !o.warehouse_id) continue;
  const set = khoCuaCamera.get(o.proof_camera_id) ?? new Set<string>();
  set.add(o.warehouse_id);
  khoCuaCamera.set(o.proof_camera_id, set);
}
/** Kho hoạt động của từng tổ chức trong cả kỳ — dùng cho ca org một kho. */
const khoCuaOrg = new Map<string, Set<string>>();
for (const o of orders) {
  if (!o.warehouse_id) continue;
  const set = khoCuaOrg.get(o.organization_id) ?? new Set<string>();
  set.add(o.warehouse_id);
  khoCuaOrg.set(o.organization_id, set);
}

interface KetQuaNgayKho {
  ngayKho: NgayKho;
  chuaChot: boolean;
  soDon: number;
  bb2MatHoanToan: number;
  thieuMotPhan: number;
  donChuaKetLuan: number;
  soBanThamGia: number;
  bb3BanPhut: number;
  nguong: number;
  datChuan: boolean;
  /** Camera có segment nhưng không gán được về kho nào — không tính, có báo. */
  banChuaGanKho: number;
}

const ketQua: KetQuaNgayKho[] = [];
const chotTruoc = nowMs - CHUA_CHOT_GIO * 3_600_000;

for (const nk of ngayKhoMap.values()) {
  // Ngày UTC kết thúc lúc 24:00 UTC; chưa qua 24 giờ kể từ đó thì chưa chốt.
  const cuoiNgayMs = new Date(`${nk.businessDate}T00:00:00.000Z`).getTime() + 86_400_000;
  const chuaChot = cuoiNgayMs > chotTruoc;

  // ---- BB-2: từng đơn ----
  let matHoanToan = 0;
  let thieuMotPhan = 0;
  let chuaKetLuan = 0;

  for (const o of nk.orders) {
    if (!o.proof_camera_id) {
      matHoanToan += 1;
      continue;
    }
    if (o.work_duration_seconds === null) {
      // Đơn đã đóng mà chưa có thời lượng: không dựng được khoảng cần
      // chứng minh. Không đoán, không tính vào BB-2.
      chuaKetLuan += 1;
      continue;
    }
    const startIso = o.work_started_at ?? o.scanned_at;
    const start = new Date(startIso).getTime();
    if (!Number.isFinite(start)) {
      chuaKetLuan += 1;
      continue;
    }
    const end = start + o.work_duration_seconds * 1_000;
    const cover = coverageOfWindow(
      segmentsOverlapping(o.proof_camera_id, start, end),
      { start, end },
    );
    if (cover.verdict === "missing") matHoanToan += 1;
    else if (cover.verdict === "partial") thieuMotPhan += 1;
    else if (cover.verdict === "defer") chuaKetLuan += 1;
  }

  // ---- BB-3: bàn-phút trong giờ hoạt động thực tế ----
  const gio = warehouseHoursFromScans(nk.orders.map((o) => o.scanned_at));

  // Tập bàn: có segment trong ngày HOẶC được gán làm camera bằng chứng.
  const banThamGia = new Set<string>();
  for (const o of nk.orders) if (o.proof_camera_id) banThamGia.add(o.proof_camera_id);

  let banChuaGanKho = 0;
  if (gio) {
    for (const [cameraId, list] of segsByCamera) {
      const coSegmentTrongGio = list.some(
        (s) => s.startMs < gio.end && s.endMs > gio.start,
      );
      if (!coSegmentTrongGio) continue;
      if (banThamGia.has(cameraId)) continue;

      const khoCuaCam = khoCuaCamera.get(cameraId);
      if (khoCuaCam?.has(nk.warehouseId)) {
        banThamGia.add(cameraId);
        continue;
      }
      if (khoCuaCam && khoCuaCam.size > 0) continue; // thuộc kho khác

      // Camera chưa từng được gán làm camera bằng chứng: chỉ quy về kho
      // này khi tổ chức đúng một kho hoạt động. Nhiều kho thì không đoán
      // — `cameras` không có cột kho, đường nối station_devices →
      // packing_stations chỉ phản ánh sơ đồ HÔM NAY, không có lịch sử.
      const khoCungOrg = khoCuaOrg.get(nk.orgId);
      if (khoCungOrg && khoCungOrg.size === 1 && khoCungOrg.has(nk.warehouseId)) {
        banThamGia.add(cameraId);
      } else {
        banChuaGanKho += 1;
      }
    }
  }

  let bb3 = 0;
  if (gio) {
    for (const cameraId of banThamGia) {
      const list = segsByCamera.get(cameraId) ?? [];
      const trongNgay = list.filter((s) => s.startMs < gio.end && s.endMs > gio.start);
      bb3 += cameraGapMinutes(cameraId, trongNgay, gio).lostMinutes;
    }
  }

  const nguong = banThamGia.size * BB1_BAN_PHUT_MOI_BAN;
  ketQua.push({
    ngayKho: nk,
    chuaChot,
    soDon: nk.orders.length,
    bb2MatHoanToan: matHoanToan,
    thieuMotPhan,
    donChuaKetLuan: chuaKetLuan,
    soBanThamGia: banThamGia.size,
    bb3BanPhut: bb3,
    nguong,
    // BB-1 chỉ xét hai điều kiện đã chốt. Ngày có đúng một đơn thì giờ
    // hoạt động bằng 0 và BB-3 tất yếu bằng 0 — đạt chuẩn, và đó là kết
    // luận đúng: không có khoảng nào để mù.
    datChuan: matHoanToan === 0 && bb3 <= nguong,
    banChuaGanKho,
  });
}

ketQua.sort((a, b) =>
  a.ngayKho.businessDate === b.ngayKho.businessDate
    ? a.ngayKho.warehouseId.localeCompare(b.ngayKho.warehouseId)
    : a.ngayKho.businessDate.localeCompare(b.ngayKho.businessDate),
);

// ============================================================================
// Tên kho
// ============================================================================

const whIds = [...new Set(ketQua.map((r) => r.ngayKho.warehouseId))].filter(
  (id) => id !== "(chưa gán kho)",
);
const tenKho = new Map<string, string>();
if (whIds.length > 0) {
  const { data } = await db.from("warehouses").select("id, name").in("id", whIds);
  for (const w of (data ?? []) as Array<{ id: string; name: string | null }>) {
    tenKho.set(w.id, w.name ?? w.id.slice(0, 8));
  }
}
const nhanKho = (id: string) => {
  const ten = tenKho.get(id) ?? id.slice(0, 8);
  // Cắt cho bảng thẳng cột. Tên dài hơn ô sẽ đẩy lệch mọi cột phía sau và
  // biến bảng thành thứ phải căng mắt đọc.
  return ten.length > 18 ? `${ten.slice(0, 17)}…` : ten;
};

// ============================================================================
// In
// ============================================================================

/** Thứ Hai của tuần chứa `businessDate`, dùng làm nhãn tuần. */
function tuanCua(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = thứ Hai
  return isoDate(new Date(d.getTime() - dow * 86_400_000));
}

if (asCsv) {
  console.log(
    "business_date,kho,don,bb2_mat_hoan_toan,thieu_mot_phan,chua_ket_luan,ban_tham_gia,bb3_ban_phut,nguong,dat_chuan,chua_chot",
  );
  for (const r of ketQua) {
    console.log(
      [
        r.ngayKho.businessDate,
        JSON.stringify(nhanKho(r.ngayKho.warehouseId)),
        r.soDon,
        r.bb2MatHoanToan,
        r.thieuMotPhan,
        r.donChuaKetLuan,
        r.soBanThamGia,
        r.bb3BanPhut,
        r.nguong,
        r.datChuan ? 1 : 0,
        r.chuaChot ? 1 : 0,
      ].join(","),
    );
  }
} else {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const num = (s: string | number, n: number) => String(s).padStart(n);

  console.log("");
  console.log(
    `${pad("Ngày", 11)}${pad("Kho", 20)}${num("Đơn", 6)}${num("BB-2", 6)}${num("Thiếu", 6)}${num("Bàn", 5)}${num("BB-3", 6)}${num("Ngưỡng", 8)}  Chuẩn`,
  );
  console.log("─".repeat(80));
  for (const r of ketQua) {
    const co = r.chuaChot ? "  ⏳ chưa chốt" : r.datChuan ? "  ✅" : "  ❌";
    console.log(
      pad(r.ngayKho.businessDate, 11) +
        pad(nhanKho(r.ngayKho.warehouseId), 20) +
        num(r.soDon, 6) +
        num(r.bb2MatHoanToan, 6) +
        num(r.thieuMotPhan, 6) +
        num(r.soBanThamGia, 5) +
        num(r.bb3BanPhut, 6) +
        num(r.nguong, 8) +
        co,
    );
  }

  const theoTuan = new Map<string, { bb1: number; bb2: number; bb3: number; ngay: number }>();
  for (const r of ketQua) {
    if (r.chuaChot) continue;
    const t = tuanCua(r.ngayKho.businessDate);
    const cur = theoTuan.get(t) ?? { bb1: 0, bb2: 0, bb3: 0, ngay: 0 };
    cur.bb1 += r.datChuan ? 1 : 0;
    cur.bb2 += r.bb2MatHoanToan;
    cur.bb3 += r.bb3BanPhut;
    cur.ngay += 1;
    theoTuan.set(t, cur);
  }

  console.log("");
  console.log(
    `${pad("Tuần từ", 12)}${num("BB-1", 8)}${num("BB-2", 8)}${num("BB-3", 10)}${num("Ngày-kho", 10)}`,
  );
  console.log("─".repeat(48));
  for (const [t, v] of [...theoTuan].sort()) {
    console.log(
      pad(t, 12) + num(v.bb1, 8) + num(v.bb2, 8) + num(v.bb3, 10) + num(v.ngay, 10),
    );
  }

  const chuaKetLuan = ketQua.reduce((n, r) => n + r.donChuaKetLuan, 0);
  const chuaGanKho = ketQua.reduce((n, r) => n + r.banChuaGanKho, 0);
  const donKhongKho = ketQua
    .filter((r) => r.ngayKho.warehouseId === "(chưa gán kho)")
    .reduce((n, r) => n + r.soDon, 0);

  console.log("");
  console.log("Chi tiết cần biết khi đọc số:");
  console.log(`  · ${chuaKetLuan} đơn chưa kết luận được (thiếu thời lượng, hoặc segment còn mở).`);
  if (segmentMoDaDong > 0)
    console.log(`  · ${segmentMoDaDong} segment còn mở quá ${SEGMENT_MO_QUA_HAN_GIO}h đã đóng bằng duration_seconds.`);
  if (chuaGanKho > 0)
    console.log(`  · ${chuaGanKho} lượt camera có segment nhưng không quy được về kho — KHÔNG tính vào BB-3.`);
  if (donKhongKho > 0)
    console.log(`  · ${donKhongKho} đơn không có warehouse_id, gom vào nhóm "(chưa gán kho)".`);
  console.log(`  · Ngày ⏳ chưa qua ${CHUA_CHOT_GIO}h nên không vào tổng tuần.`);
}
