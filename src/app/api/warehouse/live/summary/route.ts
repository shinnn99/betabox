import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { vietnamTodayUtcRange } from "@/lib/warehouse/time-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_ONLINE_WINDOW_SECONDS = 60;

export async function GET() {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const { startIso, endIso } = vietnamTodayUtcRange();
  const onlineCutoff = new Date(
    Date.now() - AGENT_ONLINE_WINDOW_SECONDS * 1000,
  ).toISOString();

  const [agents, packingToday, activeSessions, staleWarnings] = await Promise.all([
    admin
      .from("warehouse_agents")
      .select("id, code, name, status, last_seen_at")
      .eq("organization_id", ctx.organizationId)
      .order("code"),
    admin
      .from("packing_events")
      .select("status", { count: "exact" })
      .eq("organization_id", ctx.organizationId)
      .gte("scanned_at", startIso)
      .lt("scanned_at", endIso),
    admin
      .from("staff_work_sessions")
      .select("staff_id, station_id", { count: "exact" })
      .eq("organization_id", ctx.organizationId)
      .eq("status", "active"),
    admin
      .rpc("list_stale_session_warnings", {
        p_organization_id: ctx.organizationId,
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
  for (const row of packingToday.data ?? []) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  }
  const totalToday = (packingToday.data ?? []).length;

  return NextResponse.json({
    range: { start: startIso, end: endIso, timezone: "Asia/Ho_Chi_Minh" },
    agents: agentRows,
    today: {
      total_waybill_scans: totalToday,
      valid: statusCounts.valid,
      duplicated: statusCounts.duplicated,
      no_active_session: statusCounts.no_active_session,
      unmapped_scanner: statusCounts.unmapped_scanner,
      invalid_code: statusCounts.invalid_code,
    },
    active_sessions: {
      staff_count: new Set(
        (activeSessions.data ?? []).map((s) => s.staff_id),
      ).size,
      station_count: new Set(
        (activeSessions.data ?? []).map((s) => s.station_id),
      ).size,
    },
    stale_session_warnings: (staleWarnings.data ?? []) as Array<{
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
    }>,
  });
}
