import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Báo cáo VẬN HÀNH HẰNG NGÀY — trả lời "hôm nay kho chạy thế nào, chỗ nào nghẽn".
 *
 * Khác `reports/service.ts` (sản lượng + nhân sự) ở ba điểm cốt lõi, đều đến
 * từ số liệu thật đo ngày 30/09/2026 trên kho Đại Kim:
 *
 *  1. KHÔNG dùng trung bình làm thước đo nhịp. Ngày 29/09: TB 58s nhưng
 *     p50=44s, p90=133s. Trung bình che mất cái đuôi — thứ duy nhất đáng
 *     quản. Ở đây trả p50/p90, TB chỉ đi kèm để đối chiếu.
 *
 *  2. `capped_timeout` thành CHỈ SỐ, không phải thứ bị lọc im lặng.
 *     1047/3885 đơn valid (27%) rơi vào nhóm này. service.ts loại chúng khỏi
 *     trung bình là ĐÚNG, nhưng trang cũ không nói ra, nên người đọc tưởng
 *     con số thời gian phủ 100% số đơn. Mọi ô thời gian ở đây đi kèm
 *     `measured_orders`/`measured_share` làm mẫu số hiển thị được.
 *
 *  3. Gộp ở SQL, không kéo row về Node. Trang mới cần 5 nguồn (packing_events,
 *     staff_work_sessions, packing_stations, order_proof_clips,
 *     camera_recording_files); paginate từng nguồn rồi gộp bằng JS như
 *     service.ts sẽ thành vài chục nghìn row mỗi lần mở trang.
 *
 * Mọi bucket-theo-giờ tính ở SQL bằng `at time zone 'Asia/Ho_Chi_Minh'`.
 * Route chạy trên VPS/Vercel với TZ=UTC — dùng giờ của process thì lệch -7 và
 * đỉnh 9h sáng của kho sẽ hiện thành 2h sáng (cùng lý do với lib/time/vietnam.ts).
 */

export interface OperationsRange {
  from: string; // YYYY-MM-DD (ngày lịch VN)
  to: string;
  days: number;
}

/** Nhịp xử lý — luôn đi kèm mẫu số đo được, không bao giờ đứng một mình. */
export interface PaceStats {
  p50_seconds: number | null;
  p90_seconds: number | null;
  avg_seconds: number | null;
  /** Số đơn valid có duration ĐO ĐƯỢC (finalized_by_next_scan/checkout). */
  measured_orders: number;
  /** Tổng đơn valid — mẫu số của measured_share. */
  valid_orders: number;
  /** measured_orders / valid_orders, 0..1. Trang hiển thị "đo trên N%". */
  measured_share: number;
}

export interface DailyOperationPoint {
  business_date: string;
  valid: number;
  duplicated: number;
  problems: number;
  capped: number;
  p50_seconds: number | null;
  p90_seconds: number | null;
  measured_orders: number;
  first_scan_at: string | null;
  last_scan_at: string | null;
  returns: number;
}

export interface HourlyPoint {
  hour: number; // 0-23 giờ VN
  outbound: number;
  returns: number;
  /** Giờ ghi hình cộng dồn của mọi camera trong khung giờ này. */
  recording_hours: number;
}

export interface StationStat {
  station_id: string | null;
  station_name: string;
  valid_orders: number;
  capped_orders: number;
  pace: PaceStats;
}

export interface StaffOperationStat {
  staff_id: string | null;
  full_name: string;
  valid_orders: number;
  duplicated_orders: number;
  capped_orders: number;
  active_days: number;
  /** Giờ có mặt thật, từ staff_work_sessions — KHÔNG phải số ngày × 8. */
  worked_hours: number;
  /** valid_orders / worked_hours. null khi chưa có phiên nào đo được. */
  orders_per_hour: number | null;
  /** Phiên bị hệ tự đóng vì bỏ quên (end_reason='auto_closed_stale'). */
  stale_sessions: number;
  pace: PaceStats;
}

/**
 * Nhân sự của LUỒNG HOÀN — tách hẳn khỏi `StaffOperationStat` (kiện hoàn
 * không trộn vào sản lượng đóng hàng, chốt 23/09/2026).
 *
 * CÓ p50/p90 và capped, vì luồng hoàn có cấu trúc y hệt đóng hàng, chỉ khác
 * tên trường: `close_reason='timeout'` chính là bản `capped_timeout` của nó —
 * đo Đại Kim 30/09/2026 có 11/34 kiện đóng vì timeout, cả 11 đều đúng 300s
 * (trần cấu hình). Gộp nhóm đó vào thì p90 = 300s = đúng trần, vô nghĩa. Loại
 * ra thì p50=121s, p90=201s — số đo thật, dùng được.
 *
 * KHÔNG có worked_hours: nhân viên vào ca MỘT lần rồi vừa đóng hàng vừa nhận
 * hoàn, nên giờ làm là chung cho cả hai luồng, không quy riêng được.
 */
export interface ReturnStaffStat {
  staff_id: string | null;
  full_name: string;
  valid_orders: number;
  duplicated_orders: number;
  active_days: number;
  capped_orders: number;
  pace: PaceStats;
}

export interface EvidenceHealth {
  /** Ngày gần nhất có file ghi hình (giờ VN), null nếu chưa từng ghi. */
  last_recording_date: string | null;
  recording_hours_last_day: number | null;
  /** Số ngày TRONG KHOẢNG không có một file ghi hình nào. */
  days_without_recording: number;
  clips_ready: number;
  clips_failed: number;
  clips_evicted: number;
  clips_pending: number;
  open_claims: number;
  /** Khiếu nại mở đã quá hạn deadline_at. */
  overdue_claims: number;
}

export interface OperationsReport {
  range: OperationsRange;
  totals: {
    valid: number;
    duplicated: number;
    problems: number;
    capped: number;
    returns: number;
    capped_share: number; // 0..1 trên valid
    pace: PaceStats;
  };
  previous: {
    valid: number;
    capped_share: number;
    pace: PaceStats;
  };
  daily: DailyOperationPoint[];
  hourly: HourlyPoint[];
  stations: StationStat[];
  staff: StaffOperationStat[];
  /** Luồng hoàn, đếm riêng — không cộng vào `staff` ở trên. */
  return_staff: ReturnStaffStat[];
  evidence: EvidenceHealth;
}

/**
 * Danh sách timing_status được coi là ĐO ĐƯỢC, đóng cứng trong sáu RPC
 * `ops_report_*` (migration 20260930100000). Giữ tham chiếu ở đây để khi ai đó
 * sửa PACKING_EVENT_MEASURED_TIMING_STATUSES mà quên migration thì test
 * tests/reports-operations.test.ts đỏ, thay vì hai nơi lệch nhau im lặng.
 */
export const MEASURED_TIMING_IN_RPC: readonly string[] = [
  "finalized_by_next_scan",
  "finalized_by_checkout",
];

function emptyPace(): PaceStats {
  return {
    p50_seconds: null,
    p90_seconds: null,
    avg_seconds: null,
    measured_orders: 0,
    valid_orders: 0,
    measured_share: 0,
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function pace(row: {
  p50?: unknown;
  p90?: unknown;
  avg_s?: unknown;
  measured?: unknown;
  valid?: unknown;
}): PaceStats {
  const measured = num(row.measured);
  const valid = num(row.valid);
  return {
    p50_seconds: numOrNull(row.p50),
    p90_seconds: numOrNull(row.p90),
    avg_seconds: numOrNull(row.avg_s),
    measured_orders: measured,
    valid_orders: valid,
    measured_share: valid > 0 ? measured / valid : 0,
  };
}

type OpsRpc =
  | "ops_report_totals"
  | "ops_report_daily"
  | "ops_report_hourly"
  | "ops_report_stations"
  | "ops_report_staff"
  | "ops_report_return_staff"
  | "ops_report_evidence";

/**
 * Gọi một RPC gộp. Sáu hàm này có câu truy vấn ĐÓNG CỨNG trong migration và
 * chỉ nhận org + khoảng ngày — không có đường truyền SQL từ đây xuống, nên
 * không mở được lối đọc chéo tổ chức.
 */
async function callRpc<T>(
  fn: OpsRpc,
  organizationId: string,
  from: string,
  to: string,
): Promise<T[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(fn, {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
}

function shiftKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split("-").map((p) => Number.parseInt(p, 10));
  const shifted = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function dayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

/**
 * Bảy lời gọi RPC chạy song song. Mỗi hàm gộp xong ở Postgres nên phía Node
 * chỉ nhận vài chục dòng, không phải vài chục nghìn.
 */
export async function getOperationsReport(
  organizationId: string,
  from: string,
  to: string,
): Promise<OperationsReport> {
  const days = dayCount(from, to);
  const prevTo = shiftKey(from, -1);
  const prevFrom = shiftKey(from, -days);

  type Row = Record<string, unknown>;

  const [
    totalsRows,
    prevRows,
    dailyRows,
    hourlyRows,
    stationRows,
    staffRows,
    returnStaffRows,
    evidenceRows,
  ] = await Promise.all([
    callRpc<Row>("ops_report_totals", organizationId, from, to),
    callRpc<Row>("ops_report_totals", organizationId, prevFrom, prevTo),
    callRpc<Row>("ops_report_daily", organizationId, from, to),
    callRpc<Row>("ops_report_hourly", organizationId, from, to),
    callRpc<Row>("ops_report_stations", organizationId, from, to),
    callRpc<Row>("ops_report_staff", organizationId, from, to),
    callRpc<Row>("ops_report_return_staff", organizationId, from, to),
    callRpc<Row>("ops_report_evidence", organizationId, from, to),
  ]);


  const t = totalsRows[0] ?? {};
  const p = prevRows[0] ?? {};
  const e = evidenceRows[0] ?? {};

  const validNow = num(t.valid);
  const cappedNow = num(t.capped);
  const validPrev = num(p.valid);
  const cappedPrev = num(p.capped);

  return {
    range: { from, to, days },
    totals: {
      valid: validNow,
      duplicated: num(t.duplicated),
      problems: num(t.problems),
      capped: cappedNow,
      returns: num(t.returns),
      capped_share: validNow > 0 ? cappedNow / validNow : 0,
      pace: pace({ ...t, valid: validNow }),
    },
    previous: {
      valid: validPrev,
      capped_share: validPrev > 0 ? cappedPrev / validPrev : 0,
      pace: pace({ ...p, valid: validPrev }),
    },
    daily: dailyRows.map((r) => ({
      business_date: String(r.business_date),
      valid: num(r.valid),
      duplicated: num(r.duplicated),
      problems: num(r.problems),
      capped: num(r.capped),
      p50_seconds: numOrNull(r.p50),
      p90_seconds: numOrNull(r.p90),
      measured_orders: num(r.measured),
      first_scan_at: (r.first_scan_at as string | null) ?? null,
      last_scan_at: (r.last_scan_at as string | null) ?? null,
      returns: num(r.returns),
    })),
    hourly: hourlyRows.map((r) => ({
      hour: num(r.hour),
      outbound: num(r.outbound),
      returns: num(r.returns),
      recording_hours: round1(num(r.recording_hours)),
    })),
    stations: stationRows.map((r) => ({
      station_id: (r.station_id as string | null) ?? null,
      station_name: String(r.station_name),
      valid_orders: num(r.valid),
      capped_orders: num(r.capped),
      pace: pace(r),
    })),
    staff: staffRows.map((r) => {
      const worked = round1(num(r.worked_hours));
      const valid = num(r.valid);
      return {
        staff_id: (r.staff_id as string | null) ?? null,
        full_name: String(r.full_name),
        valid_orders: valid,
        duplicated_orders: num(r.duplicated),
        capped_orders: num(r.capped),
        active_days: num(r.active_days),
        worked_hours: worked,
        orders_per_hour: worked > 0 ? round1(valid / worked) : null,
        stale_sessions: num(r.stale_sessions),
        pace: pace(r),
      };
    }),
    return_staff: returnStaffRows.map((r) => ({
      staff_id: (r.staff_id as string | null) ?? null,
      full_name: String(r.full_name),
      valid_orders: num(r.valid),
      duplicated_orders: num(r.duplicated),
      active_days: num(r.active_days),
      capped_orders: num(r.capped),
      // Mẫu số ở đây là số kiện ĐÃ ĐÓNG (đo được + bị ép), không phải tổng
      // kiện: kiện còn đang mở chưa có thời lượng nào để nói tới.
      pace: pace({ ...r, valid: num(r.measured) + num(r.capped) }),
    })),
    evidence: {
      last_recording_date: (e.last_recording_date as string | null) ?? null,
      recording_hours_last_day:
        e.recording_hours_last_day === null || e.recording_hours_last_day === undefined
          ? null
          : round1(num(e.recording_hours_last_day)),
      days_without_recording: num(e.days_without_recording),
      clips_ready: num(e.clips_ready),
      clips_failed: num(e.clips_failed),
      clips_evicted: num(e.clips_evicted),
      clips_pending: num(e.clips_pending),
      open_claims: num(e.open_claims),
      overdue_claims: num(e.overdue_claims),
    },
  };
}

export { emptyPace };
