import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type RangeKey = "7d" | "30d" | "90d";
export type RangeValue = RangeKey | "custom";

export interface CustomRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export type RangeInput = { kind: "preset"; range: RangeKey } | { kind: "custom"; range: CustomRange };

export interface DailyPoint {
  business_date: string;
  total: number;
  valid: number;
  duplicated: number;
  errors: number;
  avg_duration_seconds: number | null;
}

export interface StaffStat {
  staff_id: string | null;
  full_name: string;
  email: string | null;
  video_count: number;
  valid_orders: number;
  duplicated_orders: number;
  // Đơn được đánh dấu lỗi thủ công từ /dashboard/videos. Chỉ đếm
  // trong nhóm status='valid' (đơn thật sự có nghiệp vụ đóng gói),
  // duplicated không tính để không đếm 2 lần.
  manual_error_orders: number;
  active_days: number;
  avg_videos_per_day: number;
  avg_duration_seconds: number | null;
}

export interface PerformanceSummary {
  range: RangeValue;
  from: string;
  to: string;
  days: number;
  totals: {
    total_scans: number;
    valid: number;
    duplicated: number;
    errors: number;
    accuracy: number;
    avg_duration_seconds: number | null;
    complaints_per_1000: number;
  };
  previous_totals: {
    total_scans: number;
    valid: number;
    duplicated: number;
    avg_duration_seconds: number | null;
    accuracy: number;
    complaints_per_1000: number;
  };
  daily: DailyPoint[];
  staff: StaffStat[];
}

const DAYS_BY_RANGE: Record<RangeKey, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeWindow(range: RangeKey): { from: Date; to: Date; prevFrom: Date; days: number } {
  const days = DAYS_BY_RANGE[range];
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(to.getUTCDate() - (days - 1));
  from.setUTCHours(0, 0, 0, 0);
  const prevFrom = new Date(from);
  prevFrom.setUTCDate(from.getUTCDate() - days);
  return { from, to, prevFrom, days };
}

function customWindow(custom: CustomRange): {
  from: Date;
  to: Date;
  prevFrom: Date;
  days: number;
} {
  const from = new Date(`${custom.from}T00:00:00Z`);
  const to = new Date(`${custom.to}T00:00:00Z`);
  const MS_PER_DAY = 86_400_000;
  const days = Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
  const prevFrom = new Date(from);
  prevFrom.setUTCDate(from.getUTCDate() - days);
  return { from, to, prevFrom, days };
}

type EventRow = {
  id: string;
  business_date: string;
  status: string;
  work_duration_seconds: number | null;
  order_id: string | null;
  staff_id: string | null;
  manual_error: boolean | null;
};

async function fetchEvents(
  organizationId: string,
  fromDate: string,
  toDate: string,
): Promise<EventRow[]> {
  const admin = createAdminClient();
  const out: EventRow[] = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await admin
      .from("packing_events")
      .select("id, business_date, status, work_duration_seconds, order_id, staff_id, manual_error")
      .eq("organization_id", organizationId)
      .gte("business_date", fromDate)
      .lte("business_date", toDate)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as EventRow[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

function aggregateDaily(
  rows: EventRow[],
  fromDate: string,
  toDate: string,
): DailyPoint[] {
  const byDate = new Map<
    string,
    { total: number; valid: number; duplicated: number; errors: number; durSum: number; durCount: number }
  >();

  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    byDate.set(toIsoDate(d), { total: 0, valid: 0, duplicated: 0, errors: 0, durSum: 0, durCount: 0 });
  }

  for (const r of rows) {
    const slot = byDate.get(r.business_date);
    if (!slot) continue;
    slot.total += 1;
    if (r.status === "valid") {
      slot.valid += 1;
      if (typeof r.work_duration_seconds === "number") {
        slot.durSum += r.work_duration_seconds;
        slot.durCount += 1;
      }
    } else if (r.status === "duplicated") {
      slot.duplicated += 1;
    } else {
      slot.errors += 1;
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([business_date, s]) => ({
      business_date,
      total: s.total,
      valid: s.valid,
      duplicated: s.duplicated,
      errors: s.errors,
      avg_duration_seconds: s.durCount > 0 ? s.durSum / s.durCount : null,
    }));
}

function computeTotals(daily: DailyPoint[]) {
  let total = 0;
  let valid = 0;
  let duplicated = 0;
  let errors = 0;
  let durSum = 0;
  let durCount = 0;
  for (const p of daily) {
    total += p.total;
    valid += p.valid;
    duplicated += p.duplicated;
    errors += p.errors;
    if (p.avg_duration_seconds !== null) {
      durSum += p.avg_duration_seconds * p.valid;
      durCount += p.valid;
    }
  }
  const accuracy = total > 0 ? (valid / total) * 100 : 0;
  const complaintsPer1000 = total > 0 ? ((duplicated + errors) / total) * 1000 : 0;
  return {
    total_scans: total,
    valid,
    duplicated,
    errors,
    accuracy,
    avg_duration_seconds: durCount > 0 ? durSum / durCount : null,
    complaints_per_1000: complaintsPer1000,
  };
}

async function fetchReadyClipEventIds(
  organizationId: string,
  fromDate: string,
  toDate: string,
): Promise<Set<string>> {
  const admin = createAdminClient();
  const fromIso = `${fromDate}T00:00:00Z`;
  const toIso = `${toDate}T23:59:59.999Z`;
  const ids = new Set<string>();
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await admin
      .from("order_proof_clips")
      .select("packing_event_id")
      .eq("organization_id", organizationId)
      .eq("status", "ready")
      .gte("clip_started_at", fromIso)
      .lte("clip_started_at", toIso)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { packing_event_id: string }[];
    for (const r of rows) ids.add(r.packing_event_id);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return ids;
}

async function fetchStaffProfiles(
  organizationId: string,
  staffIds: string[],
): Promise<Map<string, { full_name: string; email: string | null }>> {
  const map = new Map<string, { full_name: string; email: string | null }>();
  if (staffIds.length === 0) return map;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("staff_profiles")
    .select("id, full_name, email")
    .eq("organization_id", organizationId)
    .in("id", staffIds);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as { id: string; full_name: string; email: string | null }[]) {
    map.set(row.id, { full_name: row.full_name, email: row.email });
  }
  return map;
}

function aggregateStaff(
  rows: EventRow[],
  clipEventIds: Set<string>,
  staffProfiles: Map<string, { full_name: string; email: string | null }>,
  rangeDays: number,
): StaffStat[] {
  type Bucket = {
    valid: number;
    duplicated: number;
    manual_error: number;
    videos: number;
    durSum: number;
    durCount: number;
    dates: Set<string>;
  };
  const byStaff = new Map<string, Bucket>();
  const UNASSIGNED = "__unassigned__";

  for (const r of rows) {
    const key = r.staff_id ?? UNASSIGNED;
    let b = byStaff.get(key);
    if (!b) {
      b = {
        valid: 0,
        duplicated: 0,
        manual_error: 0,
        videos: 0,
        durSum: 0,
        durCount: 0,
        dates: new Set(),
      };
      byStaff.set(key, b);
    }
    if (r.status === "valid") {
      b.valid += 1;
      b.dates.add(r.business_date);
      if (typeof r.work_duration_seconds === "number") {
        b.durSum += r.work_duration_seconds;
        b.durCount += 1;
      }
      if (clipEventIds.has(r.id)) b.videos += 1;
      if (r.manual_error === true) b.manual_error += 1;
    } else if (r.status === "duplicated") {
      b.duplicated += 1;
    }
  }

  const result: StaffStat[] = [];
  for (const [key, b] of byStaff.entries()) {
    if (b.valid === 0 && b.duplicated === 0) continue;
    const profile = key === UNASSIGNED ? null : staffProfiles.get(key) ?? null;
    const activeDays = b.dates.size;
    const denominator = activeDays > 0 ? activeDays : rangeDays;
    result.push({
      staff_id: key === UNASSIGNED ? null : key,
      full_name: profile?.full_name ?? (key === UNASSIGNED ? "Chưa xác định" : "—"),
      email: profile?.email ?? null,
      video_count: b.videos,
      valid_orders: b.valid,
      duplicated_orders: b.duplicated,
      manual_error_orders: b.manual_error,
      active_days: activeDays,
      avg_videos_per_day: denominator > 0 ? b.videos / denominator : 0,
      avg_duration_seconds: b.durCount > 0 ? b.durSum / b.durCount : null,
    });
  }
  result.sort((a, b) => b.valid_orders - a.valid_orders);
  return result;
}

export async function getPerformanceReport(
  organizationId: string,
  input: RangeInput,
): Promise<PerformanceSummary> {
  const window =
    input.kind === "custom" ? customWindow(input.range) : rangeWindow(input.range);
  const { from, to, prevFrom, days } = window;
  const fromIso = toIsoDate(from);
  const toIso = toIsoDate(to);
  const prevFromIso = toIsoDate(prevFrom);
  const prevToIsoDate = new Date(from);
  prevToIsoDate.setUTCDate(from.getUTCDate() - 1);
  const prevToIso = toIsoDate(prevToIsoDate);

  const [currentRows, previousRows, clipEventIds] = await Promise.all([
    fetchEvents(organizationId, fromIso, toIso),
    fetchEvents(organizationId, prevFromIso, prevToIso),
    fetchReadyClipEventIds(organizationId, fromIso, toIso),
  ]);

  const staffIds = [...new Set(currentRows.map((r) => r.staff_id).filter((v): v is string => !!v))];
  const staffProfiles = await fetchStaffProfiles(organizationId, staffIds);

  const daily = aggregateDaily(currentRows, fromIso, toIso);
  const previousDaily = aggregateDaily(previousRows, prevFromIso, prevToIso);
  const staff = aggregateStaff(currentRows, clipEventIds, staffProfiles, days);

  const totals = computeTotals(daily);
  const previous = computeTotals(previousDaily);

  return {
    range: input.kind === "custom" ? "custom" : input.range,
    from: fromIso,
    to: toIso,
    days,
    totals,
    previous_totals: {
      total_scans: previous.total_scans,
      valid: previous.valid,
      duplicated: previous.duplicated,
      avg_duration_seconds: previous.avg_duration_seconds,
      accuracy: previous.accuracy,
      complaints_per_1000: previous.complaints_per_1000,
    },
    daily,
    staff,
  };
}
