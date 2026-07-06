"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock,
  Copy,
  PackageCheck,
  PackageX,
  PlugZap,
  Radio,
  ScanLine,
  Timer,
  Users,
  Warehouse as WarehouseIcon,
  WifiOff,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import StatCard from "@/components/StatCard";
import { useToast } from "@/components/ui/Toast";

const POLL_INTERVAL_MS = 3000;
const FLASH_DURATION_MS = 1500;
const AGENT_OFFLINE_BANNER_AFTER_MIN = 5;
const STATION_IDLE_WARNING_MINUTES = 10;

// ─── Types matching the live APIs ─────────────────────────────────────────

interface SummaryAgent {
  id: string;
  code: string;
  name: string;
  status: string;
  last_seen_at: string | null;
  online: boolean;
}

interface StaleSessionWarning {
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

interface SummaryResponse {
  agents: SummaryAgent[];
  today: {
    total_waybill_scans: number;
    valid: number;
    duplicated: number;
    no_active_session: number;
    unmapped_scanner: number;
    invalid_code: number;
  };
  active_sessions: { staff_count: number; station_count: number };
  stale_session_warnings: StaleSessionWarning[];
}

interface StationCard {
  station_id: string;
  station_code: string;
  station_name: string;
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

interface StationsResponse {
  stations: StationCard[];
}

type ActivityKind =
  | "session_started"
  | "session_ended"
  | "session_forced_ended"
  | "waybill_valid"
  | "waybill_duplicated"
  | "waybill_no_session"
  | "waybill_unmapped"
  | "waybill_invalid"
  | "qr_invalid";

type ActivityCategory = "ok" | "warning" | "error" | "info";

interface ActivityItem {
  id: string;
  raw_event_id: string;
  kind: ActivityKind;
  category: ActivityCategory;
  occurred_at: string;
  scanner_device_code: string | null;
  station_code: string | null;
  station_name: string | null;
  warehouse_code: string | null;
  staff_code: string | null;
  staff_name: string | null;
  waybill_code: string | null;
  note: string | null;
  work_started_at: string | null;
  work_ended_at: string | null;
  work_duration_seconds: number | null;
  timing_status: string | null;
}

interface ActivityResponse {
  activity: ActivityItem[];
}

type IssueKind =
  | "no_active_session"
  | "unmapped_scanner"
  | "duplicated"
  | "invalid_code"
  | "qr_invalid";

interface Issue {
  id: string;
  kind: IssueKind;
  title: string;
  message: string;
  occurred_at: string;
  scanner_device_code: string | null;
  station_code: string | null;
  station_name: string | null;
  staff_code: string | null;
  staff_name: string | null;
  waybill_code: string | null;
  raw_event_id: string;
}

interface IssuesResponse {
  issues: Issue[];
}

// ─── UI helpers ────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "vừa xong";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s trước`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return new Date(iso).toLocaleString("vi-VN");
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}g ${m % 60}p`;
  return `${m} phút`;
}

const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  session_started: "Vào ca",
  session_ended: "Ra ca",
  session_forced_ended: "Đổi ca",
  waybill_valid: "Hợp lệ",
  waybill_duplicated: "Trùng",
  waybill_no_session: "Chưa vào ca",
  waybill_unmapped: "Máy quét chưa gán",
  waybill_invalid: "Mã sai",
  qr_invalid: "QR sai",
};

const CATEGORY_TONE: Record<
  ActivityCategory,
  { bg: string; text: string; border: string; flash: string }
> = {
  ok: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    flash: "flash-success",
  },
  warning: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    flash: "flash-warning",
  },
  error: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    border: "border-rose-200",
    flash: "flash-error",
  },
  info: {
    bg: "bg-slate-100",
    text: "text-slate-600",
    border: "border-slate-200",
    flash: "flash-success",
  },
};

const ISSUE_KIND_ICON: Record<IssueKind, typeof CheckCircle2> = {
  duplicated: Copy,
  no_active_session: PackageX,
  unmapped_scanner: PlugZap,
  invalid_code: CircleX,
  qr_invalid: AlertTriangle,
};

const ISSUE_KIND_TONE: Record<IssueKind, "warning" | "error"> = {
  duplicated: "warning",
  no_active_session: "error",
  unmapped_scanner: "error",
  invalid_code: "error",
  qr_invalid: "error",
};

function describeActivityToast(ev: ActivityItem): {
  variant: "success" | "error" | "info";
  message: string;
} {
  const where = ev.station_name ? ` · ${ev.station_name}` : "";
  const who = ev.staff_name ? ` · ${ev.staff_name}` : "";
  switch (ev.kind) {
    case "session_started":
      return {
        variant: "success",
        message: `Vào ca: ${ev.staff_name ?? ev.staff_code ?? "?"}${where}`,
      };
    case "session_ended":
      return {
        variant: "success",
        message: `Ra ca: ${ev.staff_name ?? ev.staff_code ?? "?"}${where}`,
      };
    case "session_forced_ended":
      return {
        variant: "info",
        message: `Đổi ca tại ${ev.station_name ?? ev.scanner_device_code}`,
      };
    case "waybill_valid":
      return {
        variant: "success",
        message: `Đóng đơn ${ev.waybill_code}${who}${where}`,
      };
    case "waybill_duplicated":
      return {
        variant: "error",
        message: `Đơn ${ev.waybill_code} đã quét trước đó`,
      };
    case "waybill_no_session":
      return {
        variant: "error",
        message: `${ev.waybill_code} quét khi chưa có người vào ca`,
      };
    case "waybill_unmapped":
      return {
        variant: "error",
        message: `Máy quét ${ev.scanner_device_code} chưa gán bàn`,
      };
    case "qr_invalid":
      return {
        variant: "error",
        message: `QR nhân sự không hợp lệ`,
      };
    default:
      return { variant: "info", message: ev.note ?? "Hoạt động mới" };
  }
}

interface SystemAlert {
  key: string;
  message: string;
}

function computeAlerts(
  summary: SummaryResponse | null,
  issues: Issue[],
): SystemAlert[] {
  const alerts: SystemAlert[] = [];
  const now = Date.now();

  for (const a of summary?.agents ?? []) {
    if (a.online) continue;
    const lastSeenMs = a.last_seen_at
      ? new Date(a.last_seen_at).getTime()
      : null;
    if (!lastSeenMs) {
      alerts.push({
        key: `agent-${a.id}`,
        message: `Agent "${a.name}" (${a.code}) chưa từng kết nối tới hệ thống.`,
      });
      continue;
    }
    const minutes = Math.floor((now - lastSeenMs) / 60_000);
    if (minutes > AGENT_OFFLINE_BANNER_AFTER_MIN) {
      alerts.push({
        key: `agent-${a.id}`,
        message: `Agent "${a.name}" (${a.code}) mất kết nối ${minutes} phút.`,
      });
    }
  }

  for (const w of summary?.stale_session_warnings ?? []) {
    alerts.push({
      key: `stale-${w.session_id}`,
      message: `Phiên ${w.staff_name} tại ${w.station_name} đã mở ${w.hours_active}h — kiểm tra xem có quên ra ca không. Hệ thống sẽ tự đóng sau ${w.auto_close_threshold_hours}h.`,
    });
  }

  if (issues.length > 0) {
    const noSession = issues.filter((i) => i.kind === "no_active_session").length;
    const unmapped = issues.filter((i) => i.kind === "unmapped_scanner").length;
    if (noSession >= 3) {
      alerts.push({
        key: "no-session-burst",
        message: `${noSession} đơn quét khi chưa có ca hôm nay — kiểm tra xem nhân sự đã vào ca chưa.`,
      });
    }
    if (unmapped >= 3) {
      alerts.push({
        key: "unmapped-burst",
        message: `${unmapped} lần quét bởi máy quét chưa gán bàn hôm nay — kiểm tra cấu hình.`,
      });
    }
  }

  return alerts;
}

// ─── Page ──────────────────────────────────────────────────────────────────

type ActivityTab = "all" | "ok" | "duplicated" | "issues" | "staff";

const ACTIVITY_TAB_LABEL: Record<ActivityTab, string> = {
  all: "Tất cả",
  ok: "Hợp lệ",
  duplicated: "Trùng",
  issues: "Cần xử lý",
  staff: "QR nhân sự",
};

function matchActivityTab(ev: ActivityItem, tab: ActivityTab): boolean {
  if (tab === "all") return true;
  if (tab === "ok") return ev.kind === "waybill_valid";
  if (tab === "duplicated") return ev.kind === "waybill_duplicated";
  if (tab === "issues")
    return (
      ev.category === "error" ||
      ev.kind === "waybill_duplicated" ||
      ev.kind === "session_forced_ended"
    );
  if (tab === "staff")
    return (
      ev.kind === "session_started" ||
      ev.kind === "session_ended" ||
      ev.kind === "session_forced_ended" ||
      ev.kind === "qr_invalid"
    );
  return true;
}

export default function OperationsPage() {
  const toast = useToast();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [stations, setStations] = useState<StationCard[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<ActivityTab>("all");
  const [dismissedIssueIds, setDismissedIssueIds] = useState<Set<string>>(
    new Set(),
  );

  const inflightRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const [s1, s2, s3, s4] = await Promise.all([
        fetch("/api/warehouse/live/summary", { cache: "no-store" }),
        fetch("/api/warehouse/live/stations", { cache: "no-store" }),
        fetch("/api/warehouse/live/activity?limit=60", { cache: "no-store" }),
        fetch("/api/warehouse/live/issues?limit=30", { cache: "no-store" }),
      ]);
      if (!s1.ok || !s2.ok || !s3.ok || !s4.ok) {
        throw new Error("Một hoặc nhiều endpoint live trả lỗi");
      }
      const [sum, st, act, iss] = (await Promise.all([
        s1.json(),
        s2.json(),
        s3.json(),
        s4.json(),
      ])) as [SummaryResponse, StationsResponse, ActivityResponse, IssuesResponse];

      // Diff detect before mutating state.
      const wasFirstLoad = firstLoadRef.current;
      const newEvents: ActivityItem[] = [];
      for (const ev of act.activity) {
        if (!seenIdsRef.current.has(ev.id)) {
          seenIdsRef.current.add(ev.id);
          if (!wasFirstLoad) newEvents.push(ev);
        }
      }
      seenIdsRef.current = new Set(act.activity.map((e) => e.id));

      setSummary(sum);
      setStations(st.stations);
      setActivity(act.activity);
      setIssues(iss.issues);
      setError(null);
      setLastRefreshed(new Date());

      if (!wasFirstLoad && newEvents.length > 0) {
        for (const ev of newEvents) {
          const { variant, message } = describeActivityToast(ev);
          if (variant === "success") toast.success(message);
          else if (variant === "error") toast.error(message);
          else toast.info(message);
        }
        setFreshIds((prev) => {
          const next = new Set(prev);
          newEvents.forEach((e) => next.add(e.id));
          return next;
        });
        const fresh = newEvents.map((e) => e.id);
        setTimeout(() => {
          setFreshIds((prev) => {
            const next = new Set(prev);
            fresh.forEach((id) => next.delete(id));
            return next;
          });
        }, FLASH_DURATION_MS);
      }
      firstLoadRef.current = false;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflightRef.current = false;
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const visibleIssues = useMemo(
    () => issues.filter((i) => !dismissedIssueIds.has(i.id)),
    [issues, dismissedIssueIds],
  );

  const alerts = useMemo(
    () => computeAlerts(summary, visibleIssues),
    [summary, visibleIssues],
  );

  const filteredActivity = useMemo(
    () => activity.filter((ev) => matchActivityTab(ev, activeTab)),
    [activity, activeTab],
  );

  const onlineAgents = (summary?.agents ?? []).filter((a) => a.online).length;
  const totalAgents = (summary?.agents ?? []).length;
  const todayTotal = summary?.today.total_waybill_scans ?? 0;
  const todayValid = summary?.today.valid ?? 0;
  const todayDuplicated = summary?.today.duplicated ?? 0;
  const todayIssueCount =
    (summary?.today.no_active_session ?? 0) +
    (summary?.today.unmapped_scanner ?? 0) +
    (summary?.today.invalid_code ?? 0);

  const agentSummary =
    onlineAgents === totalAgents && totalAgents > 0
      ? `${onlineAgents}/${totalAgents} agent online`
      : `${onlineAgents}/${totalAgents} agent online — có agent mất kết nối`;

  return (
    <DashboardLayout
      pageTitle="Giám sát đóng hàng"
      pageSubtitle={
        lastRefreshed
          ? `Cập nhật ${formatTime(lastRefreshed.toISOString())} · ${agentSummary}`
          : "Đang tải..."
      }
      pageIcon={Activity}
    >
      <div className="space-y-3 lg:px-0">
        {error && (
          <div className="bg-rose-50 border border-rose-100 text-rose-700 text-sm rounded-xl px-4 py-2.5 flex items-center gap-2">
            <CircleAlert className="h-4 w-4" /> {error}
          </div>
        )}

        {alerts.length > 0 && (
          <div className="space-y-1.5">
            {alerts.map((a) => (
              <div
                key={a.key}
                className="bg-rose-50 border-l-4 border-rose-500 text-rose-800 text-sm rounded-r-xl px-4 py-2.5 flex items-start gap-2.5 shadow-sm"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-rose-500" />
                <span className="leading-snug">{a.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* 4 KPI cards — vận hành ưu tiên */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Đã quét hôm nay"
            value={String(todayTotal)}
            hint={`${todayValid} hợp lệ`}
            icon={PackageCheck}
            tone="emerald"
          />
          <StatCard
            label="Đơn trùng"
            value={String(todayDuplicated)}
            hint={todayDuplicated > 0 ? "Đã quét nhiều lần" : "Không có đơn trùng"}
            icon={Copy}
            tone={todayDuplicated > 0 ? "amber" : "emerald"}
          />
          <button
            type="button"
            onClick={() => setActiveTab("issues")}
            className="text-left transition-transform hover:scale-[1.01] active:scale-[0.99]"
          >
            <StatCard
              label="Cần xử lý"
              value={String(todayIssueCount)}
              hint={
                todayIssueCount > 0
                  ? `${summary?.today.no_active_session ?? 0} chưa vào ca · ${summary?.today.unmapped_scanner ?? 0} chưa gán bàn`
                  : "Không có lỗi cần xử lý"
              }
              icon={AlertTriangle}
              tone={todayIssueCount > 0 ? "rose" : "emerald"}
            />
          </button>
          <StatCard
            label="Nhân sự đang trực"
            value={String(summary?.active_sessions.staff_count ?? 0)}
            hint={`${summary?.active_sessions.station_count ?? 0} bàn đang hoạt động`}
            icon={Users}
            tone="blue"
          />
        </div>

        {/* Main grid: 65% stations / 35% issues */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          {/* Stations 3/5 */}
          <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  Bàn đóng hàng
                </p>
                <p className="text-xs text-slate-500">
                  {stations.length} bàn ·{" "}
                  {stations.filter((s) => s.active_session).length} đang có người
                </p>
              </div>
              <WarehouseIcon className="h-4 w-4 text-slate-400" />
            </div>
            {stations.length === 0 ? (
              <p className="text-xs text-slate-500">Chưa có bàn nào được khai báo.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {stations.map((st) => (
                  <StationCardView key={st.station_id} st={st} />
                ))}
              </div>
            )}
          </div>

          {/* Issues 2/5 */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 lg:px-5 border-b border-slate-100">
              <div>
                <p className="text-sm font-semibold text-slate-800">Cần xử lý</p>
                <p className="text-xs text-slate-500">
                  {visibleIssues.length} mục hôm nay
                </p>
              </div>
              <AlertTriangle
                className={`h-4 w-4 ${visibleIssues.length > 0 ? "text-rose-500" : "text-slate-400"}`}
              />
            </div>
            <div className="flex-1 max-h-[28rem] overflow-y-auto divide-y divide-slate-100">
              {visibleIssues.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500 mx-auto mb-1.5" />
                  <p className="text-xs text-slate-500">
                    Không có việc nào cần xử lý.
                  </p>
                </div>
              ) : (
                visibleIssues.map((iss) => {
                  const Icon = ISSUE_KIND_ICON[iss.kind];
                  const tone = ISSUE_KIND_TONE[iss.kind];
                  return (
                    <div key={iss.id} className="px-4 py-2.5">
                      <div className="flex items-start gap-2.5">
                        <div
                          className={`h-7 w-7 rounded-lg shrink-0 flex items-center justify-center ${
                            tone === "error"
                              ? "bg-rose-50 text-rose-600"
                              : "bg-amber-50 text-amber-600"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-slate-800">
                            {iss.title}
                          </p>
                          <p className="text-[11px] text-slate-600 leading-snug mt-0.5 break-all">
                            {iss.message}
                          </p>
                          <p className="text-[10px] text-slate-400 mt-1">
                            {formatTime(iss.occurred_at)}
                            {iss.station_name ? ` · ${iss.station_name}` : ""}
                            {iss.staff_name ? ` · ${iss.staff_name}` : ""}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setDismissedIssueIds((prev) => {
                              const next = new Set(prev);
                              next.add(iss.id);
                              return next;
                            })
                          }
                          className="shrink-0 h-6 px-2 text-[10px] font-semibold text-slate-500 hover:text-slate-700 rounded hover:bg-slate-100"
                        >
                          Đã xem
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Activity timeline with tabs */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
          <div className="p-4 lg:px-5 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-slate-800">
                Hoạt động gần nhất
              </p>
              <p className="text-xs text-slate-500">
                Tất cả lần quét và vào/ra ca, mới nhất ở trên
              </p>
            </div>
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-xl bg-slate-100">
              {(Object.keys(ACTIVITY_TAB_LABEL) as ActivityTab[]).map((tab) => {
                const active = tab === activeTab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                      active
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {ACTIVITY_TAB_LABEL[tab]}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            {filteredActivity.length === 0 ? (
              <p className="text-xs text-slate-500 p-4 text-center">
                Không có hoạt động phù hợp.
              </p>
            ) : (
              <table className="w-full text-sm table-fixed border-separate border-spacing-0">
                <thead>
                  <tr className="bg-white text-left text-[10px] tracking-wider text-slate-500 sticky top-0 z-10 [&>th:first-child]:rounded-tl-2xl [&>th:last-child]:rounded-tr-2xl [&>th]:border-b [&>th]:border-slate-100">
                    <th className="bg-white px-4 py-2.5 font-semibold w-44">Lúc</th>
                    <th className="bg-white px-2 py-2.5 font-semibold w-28">Loại</th>
                    <th className="bg-white px-2 py-2.5 font-semibold">Mã / nội dung</th>
                    <th className="bg-white px-2 py-2.5 font-semibold w-20">Bắt đầu</th>
                    <th className="bg-white px-2 py-2.5 font-semibold w-20">Kết thúc</th>
                    <th className="bg-white px-2 py-2.5 font-semibold w-24">Thời gian</th>
                    <th className="bg-white px-2 py-2.5 font-semibold w-28">Bàn</th>
                    <th className="bg-white px-2 py-2.5 font-semibold w-36">Nhân sự</th>
                    <th className="bg-white px-4 py-2.5 font-semibold w-52">Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActivity.map((ev) => {
                    const tone = CATEGORY_TONE[ev.category];
                    const flash = freshIds.has(ev.id) ? tone.flash : "";
                    return (
                      <tr
                        key={ev.id}
                        className={`[&>td]:border-t [&>td]:border-slate-100 hover:bg-slate-50/60 ${flash}`}
                      >
                        <td className="px-4 py-2 text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {new Date(ev.occurred_at).toLocaleString("vi-VN")}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border ${tone.bg} ${tone.text} ${tone.border} whitespace-nowrap`}
                          >
                            {ACTIVITY_KIND_LABEL[ev.kind]}
                          </span>
                        </td>
                        <td
                          className="px-2 py-2 font-mono text-[12px] text-slate-800 truncate"
                          title={ev.waybill_code ?? ""}
                        >
                          {ev.waybill_code ?? "—"}
                        </td>
                        <td className="px-2 py-2 text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {ev.work_started_at ? formatTime(ev.work_started_at) : "—"}
                        </td>
                        <td className="px-2 py-2 text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {ev.timing_status === "capped_timeout" &&
                          ev.work_started_at &&
                          ev.work_duration_seconds != null
                            ? formatTime(
                                new Date(
                                  new Date(ev.work_started_at).getTime() +
                                    ev.work_duration_seconds * 1000,
                                ).toISOString(),
                              )
                            : ev.work_ended_at
                              ? formatTime(ev.work_ended_at)
                              : "—"}
                        </td>
                        <td className="px-2 py-2 text-xs whitespace-nowrap">
                          {ev.timing_status === "open" ? (
                            <span className="text-amber-600 font-medium">đang đóng</span>
                          ) : ev.timing_status === "capped_timeout" ? (
                            <span className="text-rose-600 font-medium" title="Vượt thời gian cấu hình">
                              quá lâu
                            </span>
                          ) : ev.work_duration_seconds != null ? (
                            <span className="text-slate-700 font-medium tabular-nums">
                              {ev.work_duration_seconds < 60
                                ? `${ev.work_duration_seconds}s`
                                : `${Math.floor(ev.work_duration_seconds / 60)}p ${ev.work_duration_seconds % 60}s`}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td
                          className="px-2 py-2 text-xs text-slate-700 truncate"
                          title={ev.station_name ?? ""}
                        >
                          {ev.station_name ?? (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td
                          className="px-2 py-2 text-xs text-slate-700 truncate"
                          title={ev.staff_name ?? ""}
                        >
                          {ev.staff_name ?? (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td
                          className="px-4 py-2 text-xs text-slate-500 truncate"
                          title={ev.note ?? ""}
                        >
                          {ev.note ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Agent footer */}
        {summary?.agents && summary.agents.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 pt-1">
            <Radio className="h-3.5 w-3.5" />
            <span>Agent:</span>
            {summary.agents.map((a) => (
              <span
                key={a.id}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${
                  a.online
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-rose-50 text-rose-700"
                }`}
              >
                {a.online ? (
                  <Radio className="h-3 w-3" />
                ) : (
                  <WifiOff className="h-3 w-3" />
                )}
                {a.name} · {a.online ? "online" : `offline ${timeAgo(a.last_seen_at)}`}
              </span>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ─── Station card with rich operational info ──────────────────────────────

function StationCardView({ st }: { st: StationCard }) {
  const sess = st.active_session;
  if (!sess) {
    return (
      <div className="p-3 rounded-xl border border-slate-100 bg-slate-50/40">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 truncate">
              {st.station_name}
            </p>
            <p className="text-[11px] text-slate-500 font-mono truncate">
              {st.warehouse_code} ·{" "}
              {st.scanner_device_code ?? (
                <span className="text-rose-500">chưa gán máy quét</span>
              )}
            </p>
          </div>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-500">
            TRỐNG
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Hôm nay <span className="font-semibold text-slate-700">{st.packing_count_today}</span> đơn
        </p>
      </div>
    );
  }

  const idle = sess.idle_status === "idle";
  const accent = idle
    ? "border-amber-200 bg-amber-50/40"
    : "border-emerald-200 bg-emerald-50/40";
  const statusLabel = idle ? "ĐANG IM LẶNG" : "ĐANG TRỰC";
  const statusTone = idle
    ? "bg-amber-100 text-amber-700"
    : "bg-emerald-100 text-emerald-700";

  return (
    <div className={`p-3 rounded-xl border ${accent}`}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">
            {st.station_name}
          </p>
          <p className="text-[11px] text-slate-500 font-mono truncate">
            {st.warehouse_code} · {st.scanner_device_code ?? "chưa gán"}
          </p>
        </div>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${statusTone}`}
        >
          {statusLabel}
        </span>
      </div>

      <p className="text-sm font-medium text-slate-800 leading-tight">
        {sess.staff_code} — {sess.full_name}
      </p>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1.5 text-[11px] text-slate-600">
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3 text-slate-400" />
          <span>
            Vào ca <span className="font-medium text-slate-800">{formatTime(sess.started_at)}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Timer className="h-3 w-3 text-slate-400" />
          <span>{formatDuration(sess.duration_seconds)}</span>
        </div>
        <div className="flex items-center gap-1">
          <PackageCheck className="h-3 w-3 text-slate-400" />
          <span>
            <span className="font-semibold text-slate-800">
              {sess.packing_count_in_session}
            </span>{" "}
            đơn / phiên
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Activity className="h-3 w-3 text-slate-400" />
          <span>{sess.scans_per_hour} đơn/giờ</span>
        </div>
        <div className="flex items-center gap-1 col-span-2">
          <ScanLine className="h-3 w-3 text-slate-400" />
          <span>
            Lần quét cuối:{" "}
            <span className="font-medium text-slate-800">
              {sess.last_scan_at ? timeAgo(sess.last_scan_at) : "chưa có"}
            </span>
          </span>
        </div>
      </div>

      {(sess.errors_in_session > 0 || idle) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {sess.errors_in_session > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
              <AlertTriangle className="h-3 w-3" />
              {sess.errors_in_session} cảnh báo trong phiên
            </span>
          )}
          {idle && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
              <Clock className="h-3 w-3" />
              {STATION_IDLE_WARNING_MINUTES} phút không có scan
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>
          Hôm nay <span className="font-semibold text-slate-700">{st.packing_count_today}</span> đơn
        </span>
        <ChevronRight className="h-3 w-3" />
      </div>
    </div>
  );
}
