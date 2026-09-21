import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { vietnamTodayUtcRange } from "@/lib/warehouse/time-range";
import type { LiveFlow } from "@/lib/warehouse/live/stations";

type Admin = ReturnType<typeof createAdminClient>;

const AGENT_ONLINE_WINDOW_SECONDS = 60;

export interface StaleSessionWarning {
  session_id: string;
  station_id: string;
  station_code: string;
  station_name: string;
  staff_id: string;
  staff_code: string;
  staff_name: string;
  started_at: string;
  hours_active: number;
  warning_threshold_hours: number;
  auto_close_threshold_hours: number;
}

/**
 * Payload thẻ KPI + trạng thái agent của màn hình giám sát.
 *
 * Tách khỏi route handler để `/api/warehouse/live/overview` gọi lại được mà
 * không nhân bản logic — hai bản sao của cùng một phép đếm là hai con số
 * chực lệch nhau.
 */
export async function buildLiveSummary(
  admin: Admin,
  orgId: string,
  flow: LiveFlow = "outbound",
) {
  const { startIso, endIso } = vietnamTodayUtcRange();
  const onlineCutoff = new Date(
    Date.now() - AGENT_ONLINE_WINDOW_SECONDS * 1000,
  ).toISOString();

  const [agents, packingToday, activeSessions, staleWarnings] = await Promise.all([
    admin
      .from("warehouse_agents")
      .select("id, code, name, status, last_seen_at")
      .eq("organization_id", orgId)
      .order("code"),
    admin
      .from("packing_events")
      .select("status, timing_status, inspection_result", { count: "exact" })
      .eq("organization_id", orgId)
      // Mỗi màn hình đếm ĐÚNG luồng của nó — xem src/lib/warehouse/outbound-only.ts
      .eq("event_kind", flow)
      .gte("scanned_at", startIso)
      .lt("scanned_at", endIso),
    admin
      .from("staff_work_sessions")
      .select("staff_id, station_id", { count: "exact" })
      .eq("organization_id", orgId)
      .eq("status", "active"),
    admin.rpc("list_stale_session_warnings", {
      p_organization_id: orgId,
    }),
  ]);

  const agentRows = (agents.data ?? []).map((a) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    status: a.status,
    last_seen_at: a.last_seen_at,
    online: !!a.last_seen_at && a.last_seen_at >= onlineCutoff,
  }));

  // Aggregate today's packing statuses in-process (no need for SQL group-by
  // round-trip since the day's volume is bounded).
  const statusCounts: Record<string, number> = {
    valid: 0,
    duplicated: 0,
    no_active_session: 0,
    unmapped_scanner: 0,
    invalid_code: 0,
  };
  // Anomaly nghiệp vụ, KHÔNG phải lỗi hệ thống — đếm riêng, không cộng
  // vào statusCounts. Đơn vượt max_order_seconds vẫn có status='valid';
  // nếu không đếm tách thì 131 đơn kiểu này chìm hoàn toàn khỏi màn
  // giám sát (quan sát ở kho Đại Kim 2026-08-07).
  let cappedTimeoutToday = 0;
  let defaultEstimatedToday = 0;
  for (const row of packingToday.data ?? []) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (row.timing_status === "capped_timeout") cappedTimeoutToday += 1;
    else if (row.timing_status === "default_estimated") defaultEstimatedToday += 1;
  }
  const totalToday = (packingToday.data ?? []).length;

  if (flow === "return") {
    return {
      range: { start: startIso, end: endIso, timezone: "Asia/Ho_Chi_Minh" },
      agents: agentRows,
      today: await summarizeReturnsToday(admin, orgId, packingToday.data ?? []),
      active_sessions: {
        staff_count: new Set((activeSessions.data ?? []).map((s) => s.staff_id)).size,
        station_count: new Set((activeSessions.data ?? []).map((s) => s.station_id)).size,
      },
      stale_session_warnings: (staleWarnings.data ?? []) as StaleSessionWarning[],
    };
  }

  return {
    range: { start: startIso, end: endIso, timezone: "Asia/Ho_Chi_Minh" },
    agents: agentRows,
    today: {
      total_waybill_scans: totalToday,
      valid: statusCounts.valid,
      duplicated: statusCounts.duplicated,
      no_active_session: statusCounts.no_active_session,
      unmapped_scanner: statusCounts.unmapped_scanner,
      invalid_code: statusCounts.invalid_code,
      capped_timeout: cappedTimeoutToday,
      default_estimated: defaultEstimatedToday,
    },
    active_sessions: {
      staff_count: new Set((activeSessions.data ?? []).map((s) => s.staff_id))
        .size,
      station_count: new Set(
        (activeSessions.data ?? []).map((s) => s.station_id),
      ).size,
    },
    stale_session_warnings: (staleWarnings.data ?? []) as StaleSessionWarning[],
  };
}

/**
 * Thẻ số của Giám sát hoàn hàng.
 *
 * `open_claims` KHÔNG bó theo hôm nay: hồ sơ sống 7 ngày, và việc cần làm
 * là mọi hồ sơ chưa khiếu nại, không chỉ hồ sơ mở ra hôm nay.
 */
async function summarizeReturnsToday(
  admin: Admin,
  orgId: string,
  rows: Array<{ status: string; timing_status: string | null; inspection_result: string | null }>,
) {
  let received = 0;
  let ok = 0;
  let problem = 0;
  let duplicated = 0;
  let suspect = 0;
  let open = 0;
  for (const r of rows) {
    if (r.status === "duplicated_return") {
      duplicated += 1;
      continue;
    }
    if (r.status === "return_suspect") suspect += 1;
    received += 1;
    if (r.timing_status === "open") open += 1;
    else if (r.inspection_result === "ok") ok += 1;
    else if (r.inspection_result) problem += 1;
  }

  const { count: openClaims } = await admin
    .from("return_claims")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("status", "open");

  return {
    received,
    ok,
    problem,
    duplicated,
    suspect,
    open,
    open_claims: openClaims ?? 0,
  };
}
