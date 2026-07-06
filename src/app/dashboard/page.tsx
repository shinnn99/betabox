"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  PackageCheck,
  Clock,
  AlertTriangle,
  Activity,
  Users,
  Smartphone,
  Loader2,
  ChevronRight,
  Bell,
  CheckCircle2,
  Cctv,
  ScanLine,
  PackageOpen,
  ScanBarcode,
  ClipboardCheck,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { apiFetch, useImpersonatingOrgId } from "@/lib/api-fetch";

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
    // Counts of packing_events.timing_status='open'. These are valid
    // scans whose timing window has not been closed by the next scan
    // or the operator's checkout yet. The schema's status enum has
    // no "in_progress" — see src/lib/domain-status.ts.
    open_packing_windows: number;
    slow_open_windows: number;
    alerts: number;
  };
  yesterday: { valid: number; avg_duration_seconds: number | null };
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
  devices: { total: number; online: number; list: DeviceSnapshot[] };
  hourly: HourlyPoint[];
  staff: StaffSnapshot[];
  active_sessions: number;
  staff_total: number;
  alerts: AlertSnapshot[];
  recent_activity: RecentActivity[];
}

const REFRESH_MS = 30_000;

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function formatBusinessDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function paceTone(pct: number): string {
  if (pct >= 80) return "bg-emerald-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-rose-500";
}

function durationTone(seconds: number | null): string {
  if (seconds == null) return "text-slate-500";
  if (seconds <= 40) return "text-emerald-600";
  if (seconds <= 50) return "text-amber-600";
  return "text-rose-600";
}

type ProductionRange = "today" | "yesterday" | "7d" | "30d";

interface SeriesPoint {
  key: string;
  label: string;
  value: number;
}

const RANGE_OPTIONS: { value: ProductionRange; label: string }[] = [
  { value: "today", label: "Hôm nay" },
  { value: "yesterday", label: "Hôm qua" },
  { value: "7d", label: "7 ngày" },
  { value: "30d", label: "30 ngày" },
];

export default function DashboardPage() {
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ProductionRange>("today");
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesUnit, setSeriesUnit] = useState<"hour" | "day">("hour");
  const [rangeOpen, setRangeOpen] = useState(false);
  const impersonatingOrgId = useImpersonatingOrgId();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const fetchOverview = async () => {
      try {
        const r = await apiFetch(
          "/api/dashboard/overview",
          { cache: "no-store", signal: controller.signal },
          impersonatingOrgId,
        );
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${r.status}`);
        }
        const json = (await r.json()) as DashboardOverview;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchOverview();
    const id = setInterval(fetchOverview, REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [impersonatingOrgId]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const run = async () => {
      try {
        const r = await apiFetch(
          `/api/dashboard/production?range=${range}`,
          { cache: "no-store", signal: controller.signal },
          impersonatingOrgId,
        );
        if (!r.ok) return;
        const json = (await r.json()) as {
          series: SeriesPoint[];
          unit: "hour" | "day";
        };
        if (!cancelled) {
          setSeries(json.series);
          setSeriesUnit(json.unit);
        }
      } catch {
        // Bỏ qua: dropdown sẽ tự retry khi user đổi range.
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [range, impersonatingOrgId]);

  const maxSeries = useMemo(
    () => Math.max(1, ...series.map((h) => h.value)),
    [series],
  );
  const yAxisTicks = useMemo(() => {
    // Làm tròn max lên bội số đẹp (5, 10, 20, 50, 100…) để trục Y không bị lẻ
    const niceStep = (raw: number): number => {
      const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
      const target = raw / 4;
      return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1];
    };
    const step = niceStep(maxSeries);
    const top = Math.ceil(maxSeries / step) * step;
    const ticks: number[] = [];
    for (let v = top; v >= 0; v -= step) ticks.push(v);
    return { ticks, top };
  }, [maxSeries]);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const totals = data?.totals;
  const cameras = data?.cameras;
  const devices = data?.devices;
  const staff = data?.staff ?? [];
  const alerts = data?.alerts ?? [];
  const recent = data?.recent_activity ?? [];

  const subtitle = data
    ? `Cập nhật trực tiếp ca đóng hàng · ${formatBusinessDate(data.business_date)} · 07:00 → 19:00`
    : "Đang tải dữ liệu…";

  return (
    <DashboardLayout
      pageTitle="Trung tâm điều hành kho hôm nay"
      pageSubtitle={subtitle}
      pageIcon={LayoutDashboard}
    >
      <div className="space-y-3 text-xs">
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
            Không tải được dữ liệu: {error}
          </div>
        )}

        {/* 6 stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <MetricCard
            label="Đơn đã đóng"
            value={totals ? totals.valid.toLocaleString("vi-VN") : loading ? "…" : "0"}
            icon={PackageCheck}
            tone="emerald"
            deltaLabel={
              data?.deltas.valid_pct != null
                ? `${data.deltas.valid_pct >= 0 ? "+" : ""}${data.deltas.valid_pct}%`
                : undefined
            }
            deltaUp={data?.deltas.valid_pct != null ? data.deltas.valid_pct >= 0 : undefined}
            footnote="so với hôm qua"
          />
          <MetricCard
            label="Đang theo dõi"
            value={totals ? totals.open_packing_windows.toLocaleString("vi-VN") : loading ? "…" : "0"}
            icon={Clock}
            tone="emerald"
            footnote={
              totals && totals.slow_open_windows > 0
                ? `${totals.slow_open_windows} đơn quá 5 phút`
                : "Tất cả trong tiến độ"
            }
            footnoteIcon={Clock}
            footnoteTone={totals && totals.slow_open_windows > 0 ? "amber" : "muted"}
          />
          <MetricCard
            label="Cảnh báo hôm nay"
            value={totals ? totals.alerts.toLocaleString("vi-VN") : loading ? "…" : "0"}
            icon={AlertTriangle}
            tone="rose"
            footnote={
              totals
                ? `${totals.duplicated} trùng mã · ${totals.errors} lỗi`
                : undefined
            }
            footnoteTone="muted"
          />
          <MetricCard
            label="TB/đơn"
            value={formatDuration(totals?.avg_duration_seconds ?? null)}
            icon={Activity}
            tone="emerald"
            deltaLabel={
              data?.deltas.avg_duration_pct != null
                ? `${data.deltas.avg_duration_pct <= 0 ? "" : "+"}${data.deltas.avg_duration_pct}%`
                : undefined
            }
            deltaUp={
              data?.deltas.avg_duration_pct != null
                ? data.deltas.avg_duration_pct <= 0
                : undefined
            }
            footnote="so với hôm qua"
          />
          <MetricCard
            label="Nhân viên đang làm"
            value={
              data ? `${data.active_sessions}/${data.staff_total || data.active_sessions}` : loading ? "…" : "0/0"
            }
            icon={Users}
            tone="emerald"
            footnote={
              data && data.staff_total > data.active_sessions
                ? `${data.staff_total - data.active_sessions} tạm nghỉ`
                : "Đủ ca"
            }
            footnoteTone="muted"
          />
          <MetricCard
            label="Thiết bị hoạt động"
            value={
              devices
                ? `${devices.online}/${devices.total}`
                : loading
                ? "…"
                : "0/0"
            }
            icon={Smartphone}
            tone="emerald"
            footnote={
              devices && devices.total > devices.online
                ? `${devices.total - devices.online} máy quét offline`
                : "Tất cả online"
            }
            footnoteTone={devices && devices.total > devices.online ? "amber" : "muted"}
          />
        </div>

        {/* Trái: alerts + chart xếp dọc · Phải: trạng thái thiết bị */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="xl:col-span-2 flex flex-col gap-3">
            <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm flex flex-col">
              <div className="flex items-center gap-2 mb-3">
                <span className="h-7 w-7 rounded-lg bg-rose-50 flex items-center justify-center">
                  <AlertTriangle className="h-4 w-4 text-rose-600" />
                </span>
                <p className="text-xs font-semibold text-slate-800">
                  Cảnh báo cần xử lý
                </p>
              </div>
              <div className="flex-1 space-y-2">
                {alerts.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-400">
                    {loading ? "Đang tải…" : "Không có cảnh báo"}
                  </div>
                ) : (
                  alerts.slice(0, 3).map((a) => (
                    <AlertRow key={a.id} alert={a} />
                  ))
                )}
                {(() => {
                  const cameraDeviceList =
                    devices?.list.filter((d) => d.kind === "camera") ?? [];
                  const cameraOnlineCount = cameraDeviceList.filter(
                    (d) => d.status === "live" || d.status === "recording",
                  ).length;
                  const cameraTotal = cameraDeviceList.length;
                  // Không hiện dòng chốt khi: chưa tải xong · không có camera nào ·
                  // 0 camera online · alerts trống (đã có "Không có cảnh báo").
                  if (loading || cameraTotal === 0 || cameraOnlineCount === 0 || alerts.length === 0) {
                    return null;
                  }
                  return (
                    <div className="flex items-center gap-2 pt-2 text-xs text-slate-500">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      <span>
                        {cameraOnlineCount}/{cameraTotal} camera đang hoạt động bình thường
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-semibold text-slate-800">
                  {seriesUnit === "hour"
                    ? "Sản lượng đóng hàng theo giờ"
                    : "Sản lượng đóng hàng theo ngày"}
                </p>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setRangeOpen((v) => !v)}
                    onBlur={() => setTimeout(() => setRangeOpen(false), 100)}
                    className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 inline-flex items-center gap-1 hover:bg-slate-50"
                  >
                    {RANGE_OPTIONS.find((o) => o.value === range)?.label}
                    <ChevronRight
                      className={`h-3 w-3 transition-transform ${
                        rangeOpen ? "-rotate-90" : "rotate-90"
                      }`}
                    />
                  </button>
                  {rangeOpen && (
                    <div className="absolute right-0 top-full mt-1 w-32 rounded-lg border border-slate-100 bg-white shadow-lg py-1 z-20">
                      {RANGE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setRange(opt.value);
                            setRangeOpen(false);
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ${
                            opt.value === range
                              ? "text-emerald-600 font-semibold"
                              : "text-slate-600"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {series.length === 0 ? (
                <div className="w-full h-44 flex items-center justify-center text-xs text-slate-400">
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang tải…
                    </span>
                  ) : (
                    "Chưa có giao dịch trong ngày"
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  {/* Trục Y */}
                  <div className="flex flex-col justify-between h-44 text-xs text-slate-400 tabular-nums pr-1 pb-5">
                    {yAxisTicks.ticks.map((t) => (
                      <span key={t} className="leading-none">
                        {t}
                      </span>
                    ))}
                  </div>
                  {/* Cột */}
                  <div className="flex-1 relative">
                    {/* Gridlines */}
                    <div className="absolute inset-0 bottom-5 flex flex-col justify-between pointer-events-none">
                      {yAxisTicks.ticks.map((t) => (
                        <div key={t} className="h-px bg-slate-100" />
                      ))}
                    </div>
                    <div className="relative flex items-end gap-2 h-44">
                      {series.map((d) => {
                        const height = Math.max(
                          (d.value / yAxisTicks.top) * 100,
                          d.value > 0 ? 2 : 0,
                        );
                        const isHover = hoveredKey === d.key;
                        return (
                          <div
                            key={d.key}
                            onMouseEnter={() => setHoveredKey(d.key)}
                            onMouseLeave={() => setHoveredKey((h) => (h === d.key ? null : h))}
                            className="flex-1 h-full flex flex-col items-center justify-end relative cursor-pointer group"
                          >
                            {isHover && d.value > 0 && (
                              <div className="absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 shadow-md text-xs whitespace-nowrap z-10">
                                <p className="font-semibold text-slate-800">{d.label}</p>
                                <p className="text-slate-500 inline-flex items-center gap-1">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                  {d.value} đơn
                                </p>
                              </div>
                            )}
                            <div
                              className={`w-full max-w-[18px] rounded-t-md transition-colors ${
                                isHover
                                  ? "bg-gradient-to-t from-emerald-600 to-emerald-400"
                                  : "bg-gradient-to-t from-emerald-500 to-emerald-300"
                              }`}
                              style={{ height: `${height}%` }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex gap-2 mt-1">
                      {series.map((d, i) => {
                        // Với 30d, hiển thị nhãn cách quãng (4 ngày) cho đỡ rối
                        const showLabel =
                          series.length <= 14 || i % 4 === 0 || i === series.length - 1;
                        return (
                          <span
                            key={d.key}
                            className="flex-1 text-xs text-slate-500 text-center"
                          >
                            {showLabel ? d.label : ""}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm flex flex-col">
            <p className="text-xs font-semibold text-slate-800 mb-3">
              Trạng thái thiết bị kho
            </p>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-3 text-xs">
              <div className="text-xs text-slate-400 font-medium">
                Thiết bị
              </div>
              <div className="text-xs text-slate-400 font-medium">
                Trạng thái
              </div>
              <div className="text-xs text-slate-400 font-medium text-right">
                Ghi nhận cuối
              </div>
              {(devices?.list ?? [])
                .filter((d) => d.kind !== "station")
                .slice(0, 8)
                .map((d) => (
                  <DeviceRow key={d.id} device={d} />
                ))}
            </div>
            <Link
              href="/dashboard/devices"
              className="mt-auto pt-4 inline-flex items-center text-xs font-semibold text-emerald-600 hover:text-emerald-700"
            >
              Xem tất cả thiết bị <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Staff performance + Recent activity */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm flex flex-col">
            <p className="text-xs font-semibold text-slate-800 mb-3">
              Hiệu suất theo nhân viên
            </p>
            {staff.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-400">
                {loading ? "Đang tải…" : "Chưa có nhân viên đóng đơn hôm nay"}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-xs text-slate-400 font-medium">
                    <th className="text-left font-medium pb-2">Nhân viên</th>
                    <th className="text-left font-medium pb-2">Đơn</th>
                    <th className="text-left font-medium pb-2">TB/đơn</th>
                    <th className="text-left font-medium pb-2">Lỗi</th>
                    <th className="text-left font-medium pb-2">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.slice(0, 5).map((p) => (
                    <tr key={p.staff_id} className="border-t border-slate-50">
                      <td className="py-2.5 pr-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="h-7 w-7 rounded-full bg-slate-100 text-slate-600 text-xs font-bold flex items-center justify-center shrink-0">
                            {(p.staff_code || p.full_name.slice(0, 2)).toUpperCase().slice(0, 2)}
                          </span>
                          <span className="text-slate-700 truncate">{p.full_name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-700 w-6">
                            {p.valid_orders}
                          </span>
                          <div className="h-1.5 w-20 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className={`h-full ${paceTone(p.pct)}`}
                              style={{ width: `${p.pct}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className={`py-2.5 pr-2 font-semibold ${durationTone(p.avg_duration_seconds)}`}>
                        {formatDuration(p.avg_duration_seconds)}
                      </td>
                      <td className="py-2.5 pr-2">
                        <span
                          className={`font-semibold ${
                            p.errors > 0 ? "text-amber-600" : "text-slate-400"
                          }`}
                        >
                          {p.errors}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              p.is_active ? "bg-emerald-500" : "bg-slate-300"
                            }`}
                          />
                          <span className={p.is_active ? "text-slate-600" : "text-slate-400"}>
                            {p.is_active ? "Đang làm" : "Tạm nghỉ"}
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Link
              href="/dashboard/staff"
              className="mt-auto pt-4 inline-flex items-center text-xs font-semibold text-emerald-600 hover:text-emerald-700"
            >
              Xem tất cả nhân viên <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm flex flex-col">
            <p className="text-xs font-semibold text-slate-800 mb-3">
              Hoạt động gần đây
            </p>
            {recent.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-400">
                {loading ? "Đang tải…" : "Chưa có hoạt động"}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-xs text-slate-400 font-medium">
                    <th className="text-left font-medium pb-2">Thời gian</th>
                    <th className="text-left font-medium pb-2">Mã vận đơn</th>
                    <th className="text-left font-medium pb-2">Nhân viên</th>
                    <th className="text-left font-medium pb-2">Hoạt động</th>
                    <th className="text-left font-medium pb-2">Kết quả</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <RecentRow key={r.id} row={r} />
                  ))}
                </tbody>
              </table>
            )}
            <Link
              href="/dashboard/operations"
              className="mt-auto pt-4 inline-flex items-center text-xs font-semibold text-emerald-600 hover:text-emerald-700"
            >
              Xem tất cả hoạt động <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  icon: typeof Bell;
  tone: "emerald" | "rose";
  deltaLabel?: string;
  deltaUp?: boolean;
  footnote?: string;
  footnoteIcon?: typeof Clock;
  footnoteTone?: "muted" | "amber" | "emerald";
}

function MetricCard({
  label,
  value,
  icon: Icon,
  tone,
  deltaLabel,
  deltaUp,
  footnote,
  footnoteIcon: FootIcon,
  footnoteTone = "muted",
}: MetricCardProps) {
  const iconBg = tone === "rose" ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600";
  const footTone =
    footnoteTone === "amber"
      ? "text-amber-600"
      : footnoteTone === "emerald"
      ? "text-emerald-600"
      : "text-slate-500";
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className={`h-7 w-7 rounded-lg flex items-center justify-center ${iconBg}`}>
          <Icon className="h-4 w-4" />
        </span>
        <p className="text-xs text-slate-500">{label}</p>
      </div>
      <p className="text-3xl font-extrabold text-slate-900 leading-none tracking-tight">
        {value}
      </p>
      <div className="mt-2 flex items-center gap-1.5 text-xs">
        {deltaLabel && (
          <span
            className={`font-semibold ${
              deltaUp ? "text-emerald-600" : "text-rose-600"
            } inline-flex items-center gap-0.5`}
          >
            <span className="text-xs">{deltaUp ? "↗" : "↘"}</span>
            {deltaLabel}
          </span>
        )}
        {footnote && (
          <span className={`${footTone} inline-flex items-center gap-1`}>
            {FootIcon && <FootIcon className="h-3 w-3" />}
            {footnote}
          </span>
        )}
      </div>
    </div>
  );
}

function alertHref(alert: AlertSnapshot): string {
  // Mapping id-prefix → trang chi tiết. Prefix do API gán
  // (xem src/app/api/dashboard/overview/route.ts).
  if (alert.id.startsWith("sd:")) return "/dashboard/devices?type=scanner";
  if (alert.id.startsWith("cam:")) return "/dashboard/devices?type=camera";
  if (alert.order_code) {
    return `/dashboard/operations?q=${encodeURIComponent(alert.order_code)}`;
  }
  return "/dashboard/operations";
}

function AlertRow({ alert }: { alert: AlertSnapshot }) {
  const sev =
    alert.severity === "high"
      ? { label: "Cao", classes: "bg-rose-50 text-rose-700", dot: "bg-rose-500" }
      : alert.severity === "medium"
      ? { label: "Trung bình", classes: "bg-amber-50 text-amber-700", dot: "bg-amber-500" }
      : { label: "Thấp", classes: "bg-slate-100 text-slate-600", dot: "bg-slate-400" };
  return (
    <div className="flex items-center gap-3 p-2 rounded-xl border border-slate-100 hover:bg-slate-50">
      <span
        className={`text-xs font-bold uppercase tracking-wide px-2 py-1 rounded-md inline-flex items-center gap-1 ${sev.classes}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${sev.dot}`} />
        {sev.label}
      </span>
      <div className="min-w-0 flex-1 text-xs text-slate-700 truncate">
        {alert.order_code ? (
          <>
            Đơn <span className="font-semibold">{alert.order_code}</span>{" "}
            {alert.message.replace(`Đơn ${alert.order_code}`, "").trim()}
          </>
        ) : (
          alert.message
        )}
      </div>
      <span className="hidden md:inline text-xs text-slate-400 shrink-0">
        {alert.location ?? (alert.at ? formatTime(alert.at) : "")}
      </span>
      <Link
        href={alertHref(alert)}
        className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded-md border border-emerald-100 hover:bg-emerald-50 shrink-0"
      >
        Xem
      </Link>
    </div>
  );
}

function DeviceRow({ device }: { device: DeviceSnapshot }) {
  const Icon =
    device.kind === "camera"
      ? Cctv
      : device.kind === "scanner"
      ? ScanLine
      : PackageOpen;
  const status =
    device.status === "recording"
      ? { label: "REC", cls: "bg-rose-50 text-rose-700" }
      : device.status === "live"
      ? { label: "LIVE", cls: "bg-emerald-50 text-emerald-700" }
      : device.status === "idle"
      ? { label: "IDLE", cls: "bg-amber-50 text-amber-700" }
      : device.status === "error"
      ? { label: "ERROR", cls: "bg-rose-50 text-rose-700" }
      : { label: "OFFLINE", cls: "bg-slate-100 text-slate-500" };
  const kindLabel =
    device.kind === "camera" ? null : device.kind === "scanner" ? "Máy quét" : "Bàn đóng";
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span className="h-7 w-7 rounded-md bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-slate-700 font-medium truncate text-xs leading-tight">
            {device.code}
            {device.location && (
              <span className="text-slate-400 font-normal"> · {device.location}</span>
            )}
          </p>
          {kindLabel && (
            <p className="text-xs text-slate-400 leading-tight">{kindLabel}</p>
          )}
        </div>
      </div>
      <span
        className={`text-xs font-bold px-2 py-1 rounded-md self-center justify-self-start ${status.cls}`}
      >
        {status.label}
      </span>
      <span className="text-xs text-slate-500 self-center text-right tabular-nums">
        {formatTime(device.last_seen_at)}
      </span>
    </>
  );
}

function RecentRow({ row }: { row: RecentActivity }) {
  const result =
    row.result === "success"
      ? { label: "Thành công", cls: "text-emerald-600", Icon: CheckCircle2 }
      : row.result === "warning"
      ? { label: "Cảnh báo trùng", cls: "text-amber-600", Icon: AlertTriangle }
      : { label: "Lỗi", cls: "text-rose-600", Icon: AlertTriangle };
  const ActivityIcon =
    row.activity === "Quét đóng hàng"
      ? ScanBarcode
      : row.activity === "Quét mã"
      ? ScanLine
      : row.activity === "Đang đóng"
      ? PackageOpen
      : ClipboardCheck;
  return (
    <tr className="border-t border-slate-50">
      <td className="py-2.5 pr-2 text-slate-500 tabular-nums">{formatTime(row.at)}</td>
      <td className="py-2.5 pr-2 font-mono text-slate-700">{row.order_code ?? "—"}</td>
      <td className="py-2.5 pr-2 text-slate-700">{row.staff_name ?? "—"}</td>
      <td className="py-2.5 pr-2 text-slate-700">
        <span className="inline-flex items-center gap-1.5">
          <ActivityIcon className="h-3.5 w-3.5 text-slate-400" />
          {row.activity}
        </span>
      </td>
      <td className={`py-2.5 ${result.cls}`}>
        <span className="inline-flex items-center gap-1">
          <result.Icon className="h-3.5 w-3.5" />
          {result.label}
        </span>
      </td>
    </tr>
  );
}
