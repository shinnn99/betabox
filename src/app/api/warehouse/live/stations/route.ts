import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { vietnamTodayUtcRange } from "@/lib/warehouse/time-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDLE_WARNING_AFTER_MINUTES = 10;

interface StationCard {
  station_id: string;
  station_code: string;
  station_name: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  scanner_device_code: string | null;
  active_session: {
    session_id: string;
    staff_id: string;
    staff_code: string;
    full_name: string;
    started_at: string;
    duration_seconds: number;
    packing_count_in_session: number;
    errors_in_session: number;
    last_scan_at: string | null;
    scans_per_hour: number;
    idle_status: "active" | "idle";
  } | null;
  packing_count_today: number;
}

export async function GET() {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const { startIso, endIso } = vietnamTodayUtcRange();
  const orgId = ctx.organizationId;
  const now = new Date();

  const [stations, warehouses, assignments, sessions, packingToday] =
    await Promise.all([
      admin
        .from("packing_stations")
        .select("id, code, name, warehouse_id, status")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .order("code"),
      admin
        .from("warehouses")
        .select("id, code, name")
        .eq("organization_id", orgId),
      admin
        .from("station_device_assignments")
        .select("station_id, device_id, station_devices ( device_code )")
        .eq("organization_id", orgId)
        .is("unassigned_at", null),
      admin
        .from("staff_work_sessions")
        .select(
          "id, station_id, staff_id, started_at, staff_profiles ( staff_code, full_name )",
        )
        .eq("organization_id", orgId)
        .eq("status", "active"),
      admin
        .from("packing_events")
        .select("station_id, work_session_id, scanned_at, status")
        .eq("organization_id", orgId)
        .gte("scanned_at", startIso)
        .lt("scanned_at", endIso),
    ]);

  const warehouseById = new Map(
    (warehouses.data ?? []).map((w) => [w.id, w] as const),
  );

  const deviceByStation = new Map<string, string>();
  for (const a of assignments.data ?? []) {
    const dev = Array.isArray(a.station_devices)
      ? a.station_devices[0]
      : a.station_devices;
    if (dev?.device_code) deviceByStation.set(a.station_id, dev.device_code);
  }

  const sessionByStation = new Map<
    string,
    {
      id: string;
      staff_id: string;
      started_at: string;
      staff_code: string;
      full_name: string;
    }
  >();
  for (const s of sessions.data ?? []) {
    const sp = Array.isArray(s.staff_profiles)
      ? s.staff_profiles[0]
      : s.staff_profiles;
    if (!sp) continue;
    sessionByStation.set(s.station_id, {
      id: s.id,
      staff_id: s.staff_id,
      started_at: s.started_at,
      staff_code: sp.staff_code,
      full_name: sp.full_name,
    });
  }

  // Build per-session and per-station aggregates from today's packing events.
  const packingByStation = new Map<string, number>();
  const packingBySession = new Map<
    string,
    { total: number; errors: number; lastScanIso: string | null }
  >();
  for (const p of packingToday.data ?? []) {
    if (p.station_id) {
      packingByStation.set(
        p.station_id,
        (packingByStation.get(p.station_id) ?? 0) + 1,
      );
    }
    if (p.work_session_id) {
      const cur =
        packingBySession.get(p.work_session_id) ??
        { total: 0, errors: 0, lastScanIso: null };
      cur.total += 1;
      if (p.status !== "valid") cur.errors += 1;
      if (!cur.lastScanIso || p.scanned_at > cur.lastScanIso) {
        cur.lastScanIso = p.scanned_at;
      }
      packingBySession.set(p.work_session_id, cur);
    }
  }

  const cards: StationCard[] = (stations.data ?? []).map((st) => {
    const wh = warehouseById.get(st.warehouse_id);
    const sess = sessionByStation.get(st.id) ?? null;

    let sessionStats: StationCard["active_session"] = null;
    if (sess) {
      const stats =
        packingBySession.get(sess.id) ??
        { total: 0, errors: 0, lastScanIso: null };
      const startedMs = new Date(sess.started_at).getTime();
      const durationSec = Math.max(
        0,
        Math.floor((now.getTime() - startedMs) / 1000),
      );
      const durationHours = durationSec / 3600;
      const scansPerHour =
        durationHours > 0 ? Math.round(stats.total / durationHours) : 0;
      const lastScanMs = stats.lastScanIso
        ? new Date(stats.lastScanIso).getTime()
        : null;
      const idleStatus: "active" | "idle" =
        lastScanMs &&
        now.getTime() - lastScanMs > IDLE_WARNING_AFTER_MINUTES * 60_000
          ? "idle"
          : stats.total === 0 &&
              now.getTime() - startedMs >
                IDLE_WARNING_AFTER_MINUTES * 60_000
            ? "idle"
            : "active";

      sessionStats = {
        session_id: sess.id,
        staff_id: sess.staff_id,
        staff_code: sess.staff_code,
        full_name: sess.full_name,
        started_at: sess.started_at,
        duration_seconds: durationSec,
        packing_count_in_session: stats.total,
        errors_in_session: stats.errors,
        last_scan_at: stats.lastScanIso,
        scans_per_hour: scansPerHour,
        idle_status: idleStatus,
      };
    }

    return {
      station_id: st.id,
      station_code: st.code,
      station_name: st.name,
      warehouse_id: st.warehouse_id,
      warehouse_code: wh?.code ?? "",
      warehouse_name: wh?.name ?? "",
      scanner_device_code: deviceByStation.get(st.id) ?? null,
      active_session: sessionStats,
      packing_count_today: packingByStation.get(st.id) ?? 0,
    };
  });

  return NextResponse.json({ stations: cards });
}
