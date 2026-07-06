import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { deriveCameraOnlineState } from "@/lib/camera/online-state";
import type {
  PackingEventStatus,
  PackingEventTimingStatus,
} from "@/lib/domain-status";

export const runtime = "nodejs";

interface HourlyPoint {
  hour: number;
  label: string;
  value: number;
}

interface CameraSnapshot {
  id: string;
  camera_code: string;
  name: string;
  location: string | null;
  status: "active" | "inactive" | "error";
  recording: boolean;
}

interface StaffSnapshot {
  staff_id: string;
  full_name: string;
  staff_code: string | null;
  valid_orders: number;
  duplicated_orders: number;
  errors: number;
  avg_duration_seconds: number | null;
  pct: number;
  is_active: boolean;
}

interface AlertSnapshot {
  id: string;
  severity: "high" | "medium" | "low";
  order_code: string | null;
  message: string;
  location: string | null;
  at: string | null;
}

interface DeviceSnapshot {
  id: string;
  kind: "camera" | "scanner" | "station";
  code: string;
  name: string;
  location: string | null;
  status: "live" | "recording" | "idle" | "offline" | "error";
  last_seen_at: string | null;
}

interface RecentActivity {
  id: string;
  at: string;
  order_code: string | null;
  staff_name: string | null;
  activity: string;
  result: "success" | "warning" | "error";
}

interface DashboardOverview {
  business_date: string;
  totals: {
    valid: number;
    duplicated: number;
    errors: number;
    total: number;
    avg_duration_seconds: number | null;
    // Open packing windows: packing_events.timing_status='open'. That
    // means a valid scan landed and we're still waiting for either the
    // next scan or session checkout to close the timing window. It is
    // NOT a packing_events.status — the schema's status enum is
    // valid/duplicated/no_active_session/unmapped_scanner/invalid_code.
    open_packing_windows: number;
    // Subset of open_packing_windows whose work_started_at is older than
    // SLOW_MS — operator-facing "đơn đang vượt thời gian" hint.
    slow_open_windows: number;
    alerts: number;
  };
  yesterday: {
    valid: number;
    avg_duration_seconds: number | null;
  };
  deltas: {
    valid_pct: number | null;
    avg_duration_pct: number | null;
  };
  cameras: {
    total: number;
    active: number;
    recording: number;
    list: CameraSnapshot[];
  };
  devices: {
    total: number;
    online: number;
    list: DeviceSnapshot[];
  };
  hourly: HourlyPoint[];
  staff: StaffSnapshot[];
  active_sessions: number;
  staff_total: number;
  alerts: AlertSnapshot[];
  recent_activity: RecentActivity[];
}

function todayBusinessDate(): string {
  // business_date được lưu theo UTC date (giống reports/service.ts)
  return new Date().toISOString().slice(0, 10);
}

function previousBusinessDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current > 0 ? 100 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function GET() {
  const ctx = await requirePermission("report.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const businessDate = todayBusinessDate();
  const previousDate = previousBusinessDate(businessDate);

  try {
    const [
      todayEventsRes,
      yesterdayEventsRes,
      camerasRes,
      activeRecordingsRes,
      activeSessionsRes,
      staffProfilesRes,
      stationDevicesRes,
      packingStationsRes,
      agentForOnlineRes,
    ] = await Promise.all([
      admin
        .from("packing_events")
        .select("id, waybill_code, status, timing_status, scanned_at, work_duration_seconds, work_started_at, staff_id, station_id")
        .eq("organization_id", ctx.organizationId)
        .eq("business_date", businessDate)
        .order("scanned_at", { ascending: false }),
      admin
        .from("packing_events")
        .select("status, work_duration_seconds")
        .eq("organization_id", ctx.organizationId)
        .eq("business_date", previousDate),
      admin
        .from("cameras")
        .select(
          "id, camera_code, name, location, status, last_probe_at, last_probe_ok, last_tested_at, last_test_result",
        )
        .eq("organization_id", ctx.organizationId)
        .order("camera_code", { ascending: true }),
      admin
        .from("camera_recording_sessions")
        .select("camera_id, status")
        .eq("organization_id", ctx.organizationId)
        .eq("status", "recording"),
      admin
        .from("staff_work_sessions")
        .select("staff_id")
        .eq("organization_id", ctx.organizationId)
        .eq("status", "active"),
      admin
        .from("staff_profiles")
        .select("id, full_name, staff_code, status")
        .eq("organization_id", ctx.organizationId),
      admin
        .from("station_devices")
        .select("id, device_code, device_type, name, status, connection_status, last_seen_at")
        .eq("organization_id", ctx.organizationId)
        .neq("status", "archived"),
      admin
        .from("packing_stations")
        .select("id, code, name, status, warehouse_id")
        .eq("organization_id", ctx.organizationId)
        .neq("status", "archived"),
      // Agent gần nhất còn sống — dùng cho deriveCameraOnlineState phân
      // biệt agent-chết (warehouse_disconnected) vs camera-chết (offline).
      admin
        .from("warehouse_agents")
        .select("last_seen_at")
        .eq("organization_id", ctx.organizationId)
        .eq("status", "active")
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (todayEventsRes.error) throw new Error(todayEventsRes.error.message);
    if (yesterdayEventsRes.error) throw new Error(yesterdayEventsRes.error.message);
    if (camerasRes.error) throw new Error(camerasRes.error.message);
    if (activeRecordingsRes.error) throw new Error(activeRecordingsRes.error.message);
    if (activeSessionsRes.error) throw new Error(activeSessionsRes.error.message);
    if (staffProfilesRes.error) throw new Error(staffProfilesRes.error.message);
    if (stationDevicesRes.error) throw new Error(stationDevicesRes.error.message);
    if (packingStationsRes.error) throw new Error(packingStationsRes.error.message);

    const todayEvents = todayEventsRes.data ?? [];
    const yesterdayEvents = yesterdayEventsRes.data ?? [];

    // Aggregate totals today.
    // packing_events.status domain (CHECK constraint, verified 2026-06-30):
    //   valid, duplicated, no_active_session, unmapped_scanner, invalid_code.
    // `errors` here = anything that isn't a real packing attempt.
    // "Đang xử lý" / "Đang theo dõi" is NOT a status. It comes from
    // timing_status='open' on valid events whose timing window is still
    // waiting for next_scan or checkout.
    let valid = 0;
    let duplicated = 0;
    let errors = 0;
    let durSum = 0;
    let durCount = 0;
    let openPackingWindows = 0;
    let slowOpenWindows = 0;
    const now = Date.now();
    const SLOW_MS = 5 * 60 * 1000;
    const hourBuckets = new Array(24).fill(0) as number[];
    const staffValid = new Map<string, number>();
    const staffDup = new Map<string, number>();
    const staffErr = new Map<string, number>();
    const staffDurSum = new Map<string, number>();
    const staffDurCount = new Map<string, number>();

    for (const ev of todayEvents) {
      const s = ev.status as PackingEventStatus;
      const ts = ev.timing_status as PackingEventTimingStatus | null;
      if (s === "valid") {
        valid += 1;
        if (typeof ev.work_duration_seconds === "number") {
          durSum += ev.work_duration_seconds;
          durCount += 1;
          if (ev.staff_id) {
            staffDurSum.set(ev.staff_id, (staffDurSum.get(ev.staff_id) ?? 0) + ev.work_duration_seconds);
            staffDurCount.set(ev.staff_id, (staffDurCount.get(ev.staff_id) ?? 0) + 1);
          }
        }
        if (ev.staff_id) {
          staffValid.set(ev.staff_id, (staffValid.get(ev.staff_id) ?? 0) + 1);
        }
        if (ev.scanned_at) {
          const h = new Date(ev.scanned_at).getHours();
          if (h >= 0 && h < 24) hourBuckets[h] += 1;
        }
        // Track timing windows still open. work_started_at is set by the
        // RPC at scan time only for valid events; ignore missing values
        // defensively.
        if (ts === "open") {
          openPackingWindows += 1;
          const started = ev.work_started_at || ev.scanned_at;
          if (started && now - new Date(started).getTime() > SLOW_MS) {
            slowOpenWindows += 1;
          }
        }
      } else if (s === "duplicated") {
        duplicated += 1;
        if (ev.staff_id) {
          staffDup.set(ev.staff_id, (staffDup.get(ev.staff_id) ?? 0) + 1);
        }
      } else {
        // no_active_session | unmapped_scanner | invalid_code
        errors += 1;
        if (ev.staff_id) {
          staffErr.set(ev.staff_id, (staffErr.get(ev.staff_id) ?? 0) + 1);
        }
      }
    }

    // Yesterday
    let yValid = 0;
    let yDurSum = 0;
    let yDurCount = 0;
    for (const ev of yesterdayEvents) {
      if (ev.status === "valid") {
        yValid += 1;
        if (typeof ev.work_duration_seconds === "number") {
          yDurSum += ev.work_duration_seconds;
          yDurCount += 1;
        }
      }
    }

    const avgDuration = durCount > 0 ? durSum / durCount : null;
    const yAvgDuration = yDurCount > 0 ? yDurSum / yDurCount : null;

    // Hourly trim: chỉ trả khung giờ có hoạt động (hoặc trong ca làm việc 07-19)
    const SHIFT_START = 7;
    const SHIFT_END = 19;
    const hourly: HourlyPoint[] = [];
    for (let h = SHIFT_START; h <= SHIFT_END; h += 1) {
      hourly.push({
        hour: h,
        label: `${String(h).padStart(2, "0")}h`,
        value: hourBuckets[h] ?? 0,
      });
    }

    // Cameras
    const recordingCameraIds = new Set(
      (activeRecordingsRes.data ?? []).map((r) => r.camera_id as string),
    );
    const camerasList: CameraSnapshot[] = (camerasRes.data ?? []).map((c) => ({
      id: c.id as string,
      camera_code: c.camera_code as string,
      name: c.name as string,
      location: (c.location as string | null) ?? null,
      status: c.status as CameraSnapshot["status"],
      recording: recordingCameraIds.has(c.id as string),
    }));

    // Probe metadata + user-test metadata lookup theo id để
    // deriveCameraOnlineState. Không chèn vào CameraSnapshot public type
    // vì nó là chi tiết real-time, khác snapshot cấu hình.
    // Thêm last_tested_at/last_test_success để helper coi camera online
    // khi user vừa Test kết nối OK, kể cả khi probe loop chưa kịp cập nhật
    // (camera chưa recording → agent hiện tại không probe).
    const cameraProbeById = new Map<
      string,
      {
        last_probe_at: string | null;
        last_probe_ok: boolean | null;
        last_tested_at: string | null;
        last_test_success: boolean | null;
      }
    >();
    for (const c of camerasRes.data ?? []) {
      const tr = c.last_test_result as unknown;
      const testSuccess =
        typeof tr === "object" && tr !== null &&
        (tr as { success?: unknown }).success === true;
      cameraProbeById.set(c.id as string, {
        last_probe_at: (c.last_probe_at as string | null) ?? null,
        last_probe_ok: (c.last_probe_ok as boolean | null) ?? null,
        last_tested_at: (c.last_tested_at as string | null) ?? null,
        last_test_success: c.last_tested_at ? testSuccess : null,
      });
    }
    const agentLastSeenAt =
      (agentForOnlineRes.data?.last_seen_at as string | null) ?? null;
    const cameraTotal = camerasList.length;
    const cameraActive = camerasList.filter((c) => c.status === "active").length;

    // Staff ranking
    const staffMap = new Map<string, { full_name: string; staff_code: string | null }>();
    for (const s of staffProfilesRes.data ?? []) {
      staffMap.set(s.id as string, {
        full_name: (s.full_name as string) ?? "—",
        staff_code: (s.staff_code as string | null) ?? null,
      });
    }
    const activeStaffIds = new Set<string>();
    for (const row of activeSessionsRes.data ?? []) {
      if (row.staff_id) activeStaffIds.add(row.staff_id as string);
    }

    const allStaffIds = new Set<string>([
      ...staffValid.keys(),
      ...staffDup.keys(),
      ...staffErr.keys(),
      ...activeStaffIds,
    ]);
    const maxValid = Math.max(1, ...[...staffValid.values()]);
    const staffSnapshots: StaffSnapshot[] = [...allStaffIds].map((id) => {
      const profile = staffMap.get(id);
      const v = staffValid.get(id) ?? 0;
      const dc = staffDurCount.get(id) ?? 0;
      const ds = staffDurSum.get(id) ?? 0;
      return {
        staff_id: id,
        full_name: profile?.full_name ?? "—",
        staff_code: profile?.staff_code ?? null,
        valid_orders: v,
        duplicated_orders: staffDup.get(id) ?? 0,
        errors: staffErr.get(id) ?? 0,
        avg_duration_seconds: dc > 0 ? ds / dc : null,
        pct: Math.round((v / maxValid) * 100),
        is_active: activeStaffIds.has(id),
      };
    });
    staffSnapshots.sort((a, b) => b.valid_orders - a.valid_orders);

    // Tổng nhân viên đang hoạt động (status='active' trong staff_profiles)
    const staffTotal = (staffProfilesRes.data ?? []).filter(
      (s) => (s.status as string | null) === "active" || s.status == null,
    ).length;

    // -------- Devices (cameras + scanners + packing stations) --------
    const stationDevicesList = (stationDevicesRes.data ?? []) as Array<{
      id: string;
      device_code: string;
      device_type: string;
      name: string;
      status: string;
      connection_status: string | null;
      last_seen_at: string | null;
    }>;
    const packingStationsList = (packingStationsRes.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      status: string;
    }>;

    const deviceRows: DeviceSnapshot[] = [];
    for (const c of camerasList) {
      // Trạng thái real-time từ agent probe. Không đọc cameras.status
      // vì đó là snapshot cấu hình lần test cuối, không phản ánh việc
      // agent kho có còn kết nối lúc này hay không. Xem
      // src/lib/camera/online-state.ts cho 4 nhánh derive.
      const probe = cameraProbeById.get(c.id) ?? {
        last_probe_at: null,
        last_probe_ok: null,
        last_tested_at: null,
        last_test_success: null,
      };
      const onlineState = deriveCameraOnlineState({
        lastProbeAt: probe.last_probe_at,
        lastProbeOk: probe.last_probe_ok,
        agentLastSeenAt: agentLastSeenAt,
        hasRecordingIntent: c.recording,
        lastTestedAt: probe.last_tested_at,
        lastTestSuccess: probe.last_test_success,
        now,
      });
      const status: DeviceSnapshot["status"] = c.recording
        ? "recording"
        : onlineState === "online"
          ? "live"
          : c.status === "error"
            ? "error"
            : "offline";
      deviceRows.push({
        id: `cam:${c.id}`,
        kind: "camera",
        code: c.camera_code,
        name: c.name || c.camera_code,
        location: c.location,
        status,
        last_seen_at: null,
      });
    }
    for (const sd of stationDevicesList) {
      if (sd.device_type === "camera") continue;
      if (sd.device_type !== "scanner") continue;
      const online = sd.connection_status === "online";
      deviceRows.push({
        id: `sd:${sd.id}`,
        kind: "scanner",
        code: sd.device_code,
        name: sd.name || sd.device_code,
        location: null,
        status: online ? "live" : "offline",
        last_seen_at: sd.last_seen_at,
      });
    }
    for (const st of packingStationsList) {
      const eventsAtStation = todayEvents.filter((e) => e.station_id === st.id);
      const hasRecent = eventsAtStation.some((e) => {
        if (!e.scanned_at) return false;
        return now - new Date(e.scanned_at).getTime() < 10 * 60 * 1000;
      });
      deviceRows.push({
        id: `ps:${st.id}`,
        kind: "station",
        code: st.code,
        name: st.name || st.code,
        location: null,
        status: st.status !== "active" ? "offline" : hasRecent ? "live" : "idle",
        last_seen_at: null,
      });
    }

    // Card "Thiết bị hoạt động" chỉ đếm thiết bị thật (camera + scanner).
    // Bàn đóng là vị trí làm việc, không phải thiết bị — vẫn liệt kê trong
    // bảng trạng thái nhưng không tính vào tổng.
    const countableDevices = deviceRows.filter((d) => d.kind !== "station");
    const deviceTotal = countableDevices.length;
    const onlineDevices = countableDevices.filter(
      (d) => d.status === "live" || d.status === "recording",
    ).length;

    // -------- Alerts --------
    // packing_events.status domain (DB CHECK):
    //   valid, duplicated, no_active_session, unmapped_scanner, invalid_code.
    // The original code branched on cancelled/void/error/failed — those
    // do not exist and produced no alerts. Use the real problem statuses.
    const alerts: AlertSnapshot[] = [];
    for (const ev of todayEvents) {
      if (alerts.length >= 8) break;
      const s = ev.status as PackingEventStatus;
      if (s === "duplicated") {
        alerts.push({
          id: `dup:${ev.id}`,
          severity: "high",
          order_code: (ev.waybill_code as string | null) ?? null,
          message: `Đơn ${ev.waybill_code ?? ""} bị quét trùng`,
          location: null,
          at: (ev.scanned_at as string | null) ?? null,
        });
      } else if (s === "no_active_session") {
        alerts.push({
          id: `nosess:${ev.id}`,
          severity: "medium",
          order_code: (ev.waybill_code as string | null) ?? null,
          message: `Đơn ${ev.waybill_code ?? ""} quét khi chưa có ca trực`,
          location: null,
          at: (ev.scanned_at as string | null) ?? null,
        });
      } else if (s === "unmapped_scanner") {
        alerts.push({
          id: `unmap:${ev.id}`,
          severity: "medium",
          order_code: (ev.waybill_code as string | null) ?? null,
          message: `Máy quét chưa gán bàn — đơn ${ev.waybill_code ?? ""}`,
          location: null,
          at: (ev.scanned_at as string | null) ?? null,
        });
      } else if (s === "invalid_code") {
        alerts.push({
          id: `inv:${ev.id}`,
          severity: "low",
          order_code: (ev.waybill_code as string | null) ?? null,
          message: `Mã không hợp lệ: ${ev.waybill_code ?? "(rỗng)"}`,
          location: null,
          at: (ev.scanned_at as string | null) ?? null,
        });
      }
    }
    for (const sd of stationDevicesList) {
      if (alerts.length >= 8) break;
      if (sd.device_type === "scanner" && sd.connection_status !== "online") {
        const lastSeenMs = sd.last_seen_at ? now - new Date(sd.last_seen_at).getTime() : null;
        const minutesAgo = lastSeenMs ? Math.round(lastSeenMs / 60000) : null;
        alerts.push({
          id: `sd:${sd.id}`,
          severity: "low",
          order_code: null,
          message: `Máy quét ${sd.device_code} mất kết nối`,
          location: minutesAgo != null ? `${minutesAgo} phút trước` : null,
          at: sd.last_seen_at,
        });
      }
    }
    // Camera alerts — dùng cùng deriveCameraOnlineState với DeviceRow để
    // 2 widget không phân kỳ (bảng thiết bị / widget cảnh báo cùng 1
    // trạng thái). Gộp agent-offline: nếu nhiều camera cùng bị
    // warehouse_disconnected → 1 alert gộp "Agent kho mất kết nối — N
    // camera bị ảnh hưởng", không xả N alert riêng.
    const cameraDisconnectedByAgent: typeof camerasList = [];
    for (const c of camerasList) {
      if (alerts.length >= 8) break;
      if (c.status === "error") {
        alerts.push({
          id: `cam:${c.id}`,
          severity: "high",
          order_code: null,
          message: `Camera ${c.camera_code} báo lỗi`,
          location: c.location,
          at: null,
        });
        continue;
      }
      const probe = cameraProbeById.get(c.id) ?? {
        last_probe_at: null,
        last_probe_ok: null,
        last_tested_at: null,
        last_test_success: null,
      };
      const onlineState = deriveCameraOnlineState({
        lastProbeAt: probe.last_probe_at,
        lastProbeOk: probe.last_probe_ok,
        agentLastSeenAt,
        hasRecordingIntent: c.recording,
        lastTestedAt: probe.last_tested_at,
        lastTestSuccess: probe.last_test_success,
        now,
      });
      if (onlineState === "warehouse_disconnected") {
        cameraDisconnectedByAgent.push(c);
      } else if (onlineState === "offline") {
        alerts.push({
          id: `camoff:${c.id}`,
          severity: "medium",
          order_code: null,
          message: `Camera ${c.camera_code} mất kết nối (agent thấy nhưng không tới được camera)`,
          location: c.location,
          at: null,
        });
      }
    }
    if (cameraDisconnectedByAgent.length > 0 && alerts.length < 8) {
      const codes = cameraDisconnectedByAgent
        .map((c) => c.camera_code)
        .join(", ");
      alerts.push({
        id: "agent_offline",
        severity: "high",
        order_code: null,
        message:
          cameraDisconnectedByAgent.length === 1
            ? `Agent kho mất kết nối — camera ${codes} không ghi được`
            : `Agent kho mất kết nối — ${cameraDisconnectedByAgent.length} camera bị ảnh hưởng (${codes})`,
        location: null,
        at: agentLastSeenAt,
      });
    }

    const totalAlerts = alerts.length;

    // -------- Recent activity --------
    // Use the real packing_events.status domain. "Đang đóng" used to map
    // to non-existent in_progress/processing — drop those branches.
    const recentActivity: RecentActivity[] = todayEvents.slice(0, 6).map((ev) => {
      const s = ev.status as PackingEventStatus;
      const result: RecentActivity["result"] =
        s === "valid"
          ? "success"
          : s === "duplicated"
            ? "warning"
            : "error"; // no_active_session | unmapped_scanner | invalid_code
      const activity =
        s === "valid"
          ? "Quét đóng hàng"
          : s === "duplicated"
            ? "Quét trùng mã"
            : s === "no_active_session"
              ? "Quét ngoài ca"
              : s === "unmapped_scanner"
                ? "Máy quét chưa gán bàn"
                : "Mã không hợp lệ";
      const staffName = ev.staff_id ? staffMap.get(ev.staff_id as string)?.full_name ?? null : null;
      return {
        id: ev.id as string,
        at: (ev.scanned_at as string) ?? "",
        order_code: (ev.waybill_code as string | null) ?? null,
        staff_name: staffName,
        activity,
        result,
      };
    });

    const response: DashboardOverview = {
      business_date: businessDate,
      totals: {
        valid,
        duplicated,
        errors,
        total: valid + duplicated + errors,
        avg_duration_seconds: avgDuration,
        open_packing_windows: openPackingWindows,
        slow_open_windows: slowOpenWindows,
        alerts: totalAlerts,
      },
      yesterday: {
        valid: yValid,
        avg_duration_seconds: yAvgDuration,
      },
      deltas: {
        valid_pct: pctDelta(valid, yValid),
        avg_duration_pct:
          avgDuration !== null && yAvgDuration !== null
            ? pctDelta(avgDuration, yAvgDuration)
            : null,
      },
      cameras: {
        total: cameraTotal,
        active: cameraActive,
        recording: recordingCameraIds.size,
        list: camerasList,
      },
      devices: {
        total: deviceTotal,
        online: onlineDevices,
        list: deviceRows,
      },
      hourly,
      staff: staffSnapshots,
      active_sessions: activeStaffIds.size,
      staff_total: staffTotal,
      alerts,
      recent_activity: recentActivity,
    };

    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: "overview_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
