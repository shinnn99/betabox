import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { vietnamTodayUtcRange } from "@/lib/warehouse/time-range";

type Admin = ReturnType<typeof createAdminClient>;

const IDLE_WARNING_AFTER_MINUTES = 10;

/** Luồng mà màn hình giám sát đang xem. */
export type LiveFlow = "outbound" | "return";

export interface StationCard {
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
  /** Số lượt của ĐÚNG luồng đang xem: đơn đi, hoặc kiện hoàn. */
  packing_count_today: number;
  /** Chế độ bàn lúc này (đợt 2 hàng hoàn). */
  mode: LiveFlow;
  /** Phiên ghi hoàn của bàn, nếu bàn đang ở chế độ nhận hoàn. */
  capture_state: "none" | "active" | "draining" | "finished" | "abandoned";
}

/**
 * Thẻ bàn + ca đang mở. Xem chú thích ở buildLiveSummary.
 *
 * `flow` quyết định đếm gì: trước đây hàm này đếm MỌI lượt của bàn, nên
 * sau khi có hàng hoàn thẻ bàn trên Giám sát đóng hàng cộng lẫn cả kiện
 * hoàn vào "Hôm nay N đơn".
 */
export async function buildLiveStations(
  admin: Admin,
  orgId: string,
  flow: LiveFlow = "outbound",
): Promise<{ stations: StationCard[] }> {
  const { startIso, endIso } = vietnamTodayUtcRange();
  const now = new Date();

  const [stations, warehouses, assignments, sessions, packingToday, modePeriods] =
    await Promise.all([
      admin
        .from("packing_stations")
        .select("id, code, name, warehouse_id, status, purpose")
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
        .select("station_id, work_session_id, scanned_at, status, inspection_result")
        .eq("organization_id", orgId)
        .eq("event_kind", flow)
        .gte("scanned_at", startIso)
        .lt("scanned_at", endIso),
      admin
        .from("station_mode_periods")
        .select("station_id, mode, capture_state")
        .eq("organization_id", orgId)
        .is("ended_at", null),
    ]);

  const modeByStation = new Map<
    string,
    { mode: LiveFlow; capture_state: StationCard["capture_state"] }
  >();
  for (const m of modePeriods.data ?? []) {
    modeByStation.set(m.station_id as string, {
      mode: m.mode === "return" ? "return" : "outbound",
      capture_state: (m.capture_state ?? "none") as StationCard["capture_state"],
    });
  }

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
      // "Cảnh báo trong phiên": với đơn đi là lượt quét hỏng; với kiện hoàn
      // là kiện có vấn đề (kết quả khác OK) hoặc quét lại / bị lưới an toàn bắt.
      const problem =
        flow === "return"
          ? p.status !== "valid" ||
            (p.inspection_result !== null && p.inspection_result !== "ok")
          : p.status !== "valid";
      if (problem) cur.errors += 1;
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
      // Chưa có kỳ nào thì chế độ là mặc định của bàn — cùng luật với
      // station_current_mode() ở DB.
      mode: modeByStation.get(st.id)?.mode ?? (st.purpose === "return" ? "return" : "outbound"),
      capture_state: modeByStation.get(st.id)?.capture_state ?? "none",
    };
  });

  return { stations: cards };
}
