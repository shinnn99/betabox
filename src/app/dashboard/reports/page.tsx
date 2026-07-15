"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  TrendingUp,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  PackageCheck,
  Clock,
  AlertTriangle,
  Target,
  Loader2,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import StatCard from "@/components/StatCard";

type RangeKey = "7d" | "30d" | "90d";
type RangeValue = RangeKey | "custom";

interface CustomRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

type RangeSelection = { kind: "preset"; value: RangeKey } | { kind: "custom"; value: CustomRange };

interface DailyPoint {
  business_date: string;
  total: number;
  valid: number;
  duplicated: number;
  errors: number;
  avg_duration_seconds: number | null;
}

interface StaffStat {
  staff_id: string | null;
  full_name: string;
  email: string | null;
  video_count: number;
  valid_orders: number;
  duplicated_orders: number;
  manual_error_orders: number;
  active_days: number;
  avg_videos_per_day: number;
  avg_duration_seconds: number | null;
}

interface PerformanceSummary {
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

const RANGE_LABEL: Record<RangeKey, string> = {
  "7d": "7 ngày",
  "30d": "30 ngày",
  "90d": "90 ngày",
};

const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "30d": 30, "90d": 90 };

function presetDays(r: RangeKey): number {
  return RANGE_DAYS[r];
}

const MAX_CUSTOM_DAYS = 366;

const WEEKDAY_LABEL = ["CN", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function pctDelta(current: number, previous: number): number | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  if (previous === 0) return current > 0 ? 100 : undefined;
  return Math.round(((current - previous) / previous) * 100);
}

function formatDayLabel(iso: string, totalDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (totalDays <= 7) return WEEKDAY_LABEL[d.getUTCDay()];
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatVnDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

interface FetchState {
  status: "idle" | "loading" | "success" | "error";
  data: PerformanceSummary | null;
  error: string | null;
}

export default function ReportsPage() {
  const [selection, setSelection] = useState<RangeSelection>({ kind: "preset", value: "7d" });
  const [state, setState] = useState<FetchState>({
    status: "loading",
    data: null,
    error: null,
  });

  const queryString = useMemo(() => {
    if (selection.kind === "custom") {
      return `from=${selection.value.from}&to=${selection.value.to}`;
    }
    return `range=${selection.value}`;
  }, [selection]);

  useEffect(() => {
    const controller = new AbortController();

    const run = async () => {
      setState((prev) => ({ status: "loading", data: prev.data, error: null }));
      try {
        const r = await fetch(`/api/reports/performance?${queryString}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${r.status}`);
        }
        const d = (await r.json()) as PerformanceSummary;
        if (!controller.signal.aborted) {
          setState({ status: "success", data: d, error: null });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          status: "error",
          data: prev.data,
          error: (e as Error).message,
        }));
      }
    };

    void run();

    return () => controller.abort();
  }, [queryString]);

  const data = state.data;
  const loading = state.status === "loading";
  const error = state.error;

  const daily = useMemo(() => data?.daily ?? [], [data]);
  const staff = useMemo(() => data?.staff ?? [], [data]);

  const totals = data?.totals;
  const previous = data?.previous_totals;

  const deltaTotal = totals && previous ? pctDelta(totals.total_scans, previous.total_scans) : undefined;
  const deltaAvg =
    totals?.avg_duration_seconds != null && previous?.avg_duration_seconds != null
      ? pctDelta(totals.avg_duration_seconds, previous.avg_duration_seconds)
      : undefined;
  const deltaAcc = totals && previous ? pctDelta(totals.accuracy, previous.accuracy) : undefined;
  const dupRate = totals && totals.total_scans > 0
    ? (totals.duplicated / totals.total_scans) * 100
    : 0;
  const prevDupRate = previous && previous.total_scans > 0
    ? (previous.duplicated / previous.total_scans) * 100
    : 0;
  const deltaDup = totals && previous ? pctDelta(dupRate, prevDupRate) : undefined;

  const rangeLabel =
    selection.kind === "preset"
      ? RANGE_LABEL[selection.value]
      : data
        ? `${formatVnDate(data.from)} → ${formatVnDate(data.to)}`
        : "tuỳ chỉnh";
  const chartDays = data?.days ?? (selection.kind === "preset" ? presetDays(selection.value) : 30);

  return (
    <DashboardLayout
      pageTitle="Báo cáo hiệu suất"
      pageSubtitle="Tổng quan sản lượng, thời gian xử lý & tỷ lệ chuẩn xác"
      pageIcon={BarChart3}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 p-3 lg:p-4 shadow-sm flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((r) => {
              const active = selection.kind === "preset" && selection.value === r;
              return (
                <button
                  key={r}
                  onClick={() => setSelection({ kind: "preset", value: r })}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                    active
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {RANGE_LABEL[r]}
                </button>
              );
            })}
          </div>
          <CustomRangePicker
            value={selection.kind === "custom" ? selection.value : null}
            onApply={(range) => setSelection({ kind: "custom", value: range })}
          />
          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang tải…
            </span>
          )}
          {error && (
            <span className="text-xs text-rose-600">Lỗi: {error}</span>
          )}
          <button className="ml-auto h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-2 text-sm font-semibold">
            <Download className="h-4 w-4" /> Xuất báo cáo
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label={`Tổng đơn (${rangeLabel})`}
            value={totals ? totals.total_scans.toLocaleString("vi-VN") : "—"}
            icon={PackageCheck}
            tone="emerald"
            delta={deltaTotal}
          />
          <StatCard
            label="Thời gian TB"
            value={formatDuration(totals?.avg_duration_seconds ?? null)}
            icon={Clock}
            tone="blue"
            delta={deltaAvg !== undefined ? -deltaAvg : undefined}
            hint="thời gian xử lý/đơn"
          />
          <StatCard
            label="Tỷ lệ chuẩn xác"
            value={totals ? `${totals.accuracy.toFixed(1)}%` : "—"}
            icon={Target}
            tone="violet"
            delta={deltaAcc}
          />
          <StatCard
            label="Tỷ lệ trùng"
            value={totals ? `${dupRate.toFixed(1)}%` : "—"}
            icon={AlertTriangle}
            tone="rose"
            delta={deltaDup !== undefined ? -deltaDup : undefined}
            hint={totals ? `${totals.duplicated.toLocaleString("vi-VN")} lượt trùng` : undefined}
          />
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-slate-800">
                Sản lượng đóng hàng theo ngày
              </p>
              <p className="text-xs text-slate-500">
                {data ? `${data.from} → ${data.to}` : "—"}
              </p>
            </div>
            {deltaTotal !== undefined && deltaTotal >= 0 && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md">
                <TrendingUp className="h-3 w-3" /> Tăng trưởng tốt
              </span>
            )}
          </div>
          {daily.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-sm text-slate-400">
              {loading ? "Đang tải dữ liệu…" : "Chưa có dữ liệu trong khoảng này"}
            </div>
          ) : (
            <DailyLineChart daily={daily} totalDays={chartDays} />
          )}
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 lg:p-5 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-800">Báo cáo theo nhân sự</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Thống kê thao tác đóng hàng của từng thành viên trong khoảng đang xem
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/60">
                <tr className="text-left text-[11px] tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-semibold">Tên thành viên</th>
                  <th className="px-4 py-3 font-semibold text-right">Số đơn</th>
                  <th className="px-4 py-3 font-semibold text-right">Số đơn đóng trùng</th>
                  <th
                    className="px-4 py-3 font-semibold text-right"
                    title="Đơn được đánh dấu lỗi thủ công từ trang Bằng chứng giao hàng (khiếu nại, đóng sai, sai người)."
                  >
                    Số đơn lỗi
                  </th>
                  <th
                    className="px-4 py-3 font-semibold text-right"
                    title="Tỉ lệ = số đơn lỗi / số đơn"
                  >
                    Tỉ lệ đơn lỗi
                  </th>
                  <th className="px-4 py-3 font-semibold text-right">TB đơn/ngày</th>
                  <th className="px-4 py-3 font-semibold text-right">Thời gian đóng/đơn</th>
                </tr>
              </thead>
              <tbody>
                {staff.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">
                      {loading ? "Đang tải…" : "Không có dữ liệu"}
                    </td>
                  </tr>
                ) : (
                  staff.map((s, idx) => {
                    const errorRate =
                      s.valid_orders > 0 ? (s.manual_error_orders / s.valid_orders) * 100 : null;
                    const avgOrdersPerDay =
                      s.active_days > 0 ? s.valid_orders / s.active_days : 0;
                    return (
                      <tr
                        key={s.staff_id ?? `unassigned-${idx}`}
                        className="border-t border-slate-100 hover:bg-slate-50/60"
                      >
                        <td className="px-4 py-3 font-medium text-slate-800">{s.full_name}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">
                          {s.valid_orders.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-600">
                          {s.duplicated_orders.toLocaleString("vi-VN")}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono ${
                            s.manual_error_orders > 0
                              ? "text-rose-600 font-semibold"
                              : "text-slate-500"
                          }`}
                        >
                          {s.manual_error_orders.toLocaleString("vi-VN")}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono ${
                            errorRate !== null && errorRate > 0
                              ? "text-rose-600 font-semibold"
                              : "text-slate-500"
                          }`}
                        >
                          {errorRate === null ? "—" : `${errorRate.toFixed(1)}%`}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">
                          {avgOrdersPerDay.toFixed(1)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-600">
                          {formatDuration(s.avg_duration_seconds)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function CustomRangePicker({
  value,
  onApply,
}: {
  value: CustomRange | null;
  onApply: (r: CustomRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => isoDate(new Date()), []);
  const [from, setFrom] = useState<string>(value?.from ?? today);
  const [to, setTo] = useState<string>(value?.to ?? today);

  useEffect(() => {
    if (value) {
      setFrom(value.from);
      setTo(value.to);
    }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const validation = useMemo(() => {
    if (!from || !to) return "Chọn cả ngày bắt đầu và ngày kết thúc";
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return "Ngày không hợp lệ";
    if (toMs < fromMs) return "Ngày kết thúc phải sau ngày bắt đầu";
    const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
    if (days > MAX_CUSTOM_DAYS) return `Khoảng tối đa ${MAX_CUSTOM_DAYS} ngày`;
    return null;
  }, [from, to]);

  const active = value !== null;
  const buttonLabel = active
    ? `${formatVnDate(value!.from)} → ${formatVnDate(value!.to)}`
    : "Tuỳ chỉnh khoảng";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`h-9 px-3 rounded-xl inline-flex items-center gap-2 text-sm border transition-colors ${
          active
            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
            : "border-slate-200 hover:bg-slate-50 text-slate-700"
        }`}
      >
        <Calendar className="h-4 w-4" /> {buttonLabel}
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-lg p-3 space-y-3">
          <DateField label="Từ ngày" value={from} max={today} onChange={setFrom} />
          <DateField label="Đến ngày" value={to} max={today} min={from} onChange={setTo} />
          {validation && <p className="text-xs text-rose-600">{validation}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 px-3 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              Huỷ
            </button>
            <button
              type="button"
              disabled={validation !== null}
              onClick={() => {
                onApply({ from, to });
                setOpen(false);
              }}
              className="h-8 px-3 rounded-lg text-xs font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
            >
              Áp dụng
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
        {label}
      </label>
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full h-9 rounded-lg border border-slate-200 px-3 text-sm text-left flex items-center justify-between hover:border-slate-300 focus:outline-none focus:border-emerald-400"
        >
          <span className={value ? "text-slate-800" : "text-slate-400"}>
            {value ? formatVnDate(value) : "dd/mm/yyyy"}
          </span>
          <Calendar className="h-4 w-4 text-slate-400" />
        </button>
        {open && (
          <div className="absolute z-30 left-0 mt-1 rounded-xl border border-slate-200 bg-white shadow-lg p-2">
            <MonthCalendar
              value={value}
              min={min}
              max={max}
              onSelect={(v) => {
                onChange(v);
                setOpen(false);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const MONTH_LABEL_VN = [
  "Tháng 1",
  "Tháng 2",
  "Tháng 3",
  "Tháng 4",
  "Tháng 5",
  "Tháng 6",
  "Tháng 7",
  "Tháng 8",
  "Tháng 9",
  "Tháng 10",
  "Tháng 11",
  "Tháng 12",
];
const WEEKDAY_SHORT_VN = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

function parseIsoLocal(iso: string | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function MonthCalendar({
  value,
  min,
  max,
  onSelect,
}: {
  value: string;
  min?: string;
  max?: string;
  onSelect: (iso: string) => void;
}) {
  const selectedDate = useMemo(() => parseIsoLocal(value), [value]);
  const minDate = useMemo(() => parseIsoLocal(min), [min]);
  const maxDate = useMemo(() => parseIsoLocal(max), [max]);
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const base = selectedDate ?? today;
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  const firstOfMonth = new Date(view.year, view.month, 1);
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  // Mon-first: shift so Monday = 0
  const jsWeekday = firstOfMonth.getDay(); // 0=Sun..6=Sat
  const leading = (jsWeekday + 6) % 7;

  const cells: (Date | null)[] = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(view.year, view.month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const inRange = (d: Date) => {
    if (minDate && d < minDate) return false;
    if (maxDate && d > maxDate) return false;
    return true;
  };

  const goto = (delta: number) => {
    setView((v) => {
      const nm = v.month + delta;
      const year = v.year + Math.floor(nm / 12);
      const month = ((nm % 12) + 12) % 12;
      return { year, month };
    });
  };

  return (
    <div className="w-72 select-none">
      <div className="flex items-center justify-between px-1 pb-2">
        <button
          type="button"
          onClick={() => goto(-1)}
          className="h-7 w-7 rounded-md hover:bg-slate-100 inline-flex items-center justify-center text-slate-600"
          aria-label="Tháng trước"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-sm font-semibold text-slate-800">
          {MONTH_LABEL_VN[view.month]} {view.year}
        </div>
        <button
          type="button"
          onClick={() => goto(1)}
          className="h-7 w-7 rounded-md hover:bg-slate-100 inline-flex items-center justify-center text-slate-600"
          aria-label="Tháng sau"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAY_SHORT_VN.map((w) => (
          <div key={w} className="text-[11px] font-semibold text-slate-400 py-1">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`empty-${i}`} className="h-8" />;
          const iso = isoDate(d);
          const selected = selectedDate ? isSameDay(d, selectedDate) : false;
          const isToday = isSameDay(d, today);
          const disabled = !inRange(d);
          return (
            <button
              key={iso}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(iso)}
              className={`h-8 rounded-md text-xs font-medium transition-colors ${
                selected
                  ? "bg-emerald-500 text-white hover:bg-emerald-600"
                  : disabled
                    ? "text-slate-300 cursor-not-allowed"
                    : isToday
                      ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-2 px-1 text-xs">
        <button
          type="button"
          onClick={() => onSelect(isoDate(today))}
          className="text-emerald-600 hover:text-emerald-700 font-semibold"
        >
          Hôm nay
        </button>
      </div>
    </div>
  );
}

function DailyLineChart({ daily, totalDays }: { daily: DailyPoint[]; totalDays: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = 240;
  const padding = { top: 16, right: 20, bottom: 36, left: 48 };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(0, width - padding.left - padding.right);
  const innerH = height - padding.top - padding.bottom;

  const maxValue = Math.max(
    1,
    ...daily.map((d) => Math.max(d.valid, d.duplicated, d.errors)),
  );
  const ticks = niceTicks(maxValue, 4);
  const tickMax = ticks[ticks.length - 1];

  const stepX = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const xAt = (i: number) => padding.left + stepX * i;
  const yAt = (v: number) => padding.top + innerH - (v / tickMax) * innerH;

  const buildPath = (key: "valid" | "duplicated" | "errors") =>
    daily
      .map((d, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(d[key]).toFixed(2)}`)
      .join(" ");

  const buildArea = (key: "valid" | "duplicated" | "errors") => {
    const line = daily
      .map((d, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(d[key]).toFixed(2)}`)
      .join(" ");
    const lastX = xAt(daily.length - 1);
    const firstX = xAt(0);
    const baseY = padding.top + innerH;
    return `${line} L ${lastX.toFixed(2)} ${baseY} L ${firstX.toFixed(2)} ${baseY} Z`;
  };

  const showEveryNthLabel = Math.max(1, Math.ceil(daily.length / 14));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <span className="text-slate-600">Số đơn</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <span className="text-slate-600">Đơn lặp</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
          <span className="text-slate-600">Đơn lỗi</span>
        </span>
      </div>
      <div ref={containerRef} className="w-full">
        <svg width={width} height={height} role="img" className="block">
          <defs>
            <linearGradient id="reports-valid-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="reports-dup-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(245 158 11)" stopOpacity="0.12" />
              <stop offset="100%" stopColor="rgb(245 158 11)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="reports-err-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.12" />
              <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((t) => {
            const y = yAt(t);
            return (
              <g key={t}>
                <line
                  x1={padding.left}
                  x2={padding.left + innerW}
                  y1={y}
                  y2={y}
                  stroke="rgb(241 245 249)"
                  strokeWidth={1}
                />
                <text
                  x={padding.left - 8}
                  y={y + 3}
                  fontSize={12}
                  textAnchor="end"
                  fill="rgb(148 163 184)"
                >
                  {t}
                </text>
              </g>
            );
          })}

          <path d={buildArea("valid")} fill="url(#reports-valid-area)" />
          <path d={buildArea("duplicated")} fill="url(#reports-dup-area)" />
          <path d={buildArea("errors")} fill="url(#reports-err-area)" />

          <path
            d={buildPath("valid")}
            fill="none"
            stroke="rgb(16 185 129)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={buildPath("duplicated")}
            fill="none"
            stroke="rgb(245 158 11)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={buildPath("errors")}
            fill="none"
            stroke="rgb(244 63 94)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {daily.map((d, i) => (
            <g key={`pts-${d.business_date}`}>
              <circle cx={xAt(i)} cy={yAt(d.valid)} r={3} fill="rgb(16 185 129)" />
              <circle cx={xAt(i)} cy={yAt(d.duplicated)} r={3} fill="rgb(245 158 11)" />
              <circle cx={xAt(i)} cy={yAt(d.errors)} r={3} fill="rgb(244 63 94)" />
              <title>
                {`${d.business_date} · Đơn: ${d.valid} · Lặp: ${d.duplicated} · Lỗi: ${d.errors}`}
              </title>
            </g>
          ))}

          {daily.map((d, i) => {
            if (i % showEveryNthLabel !== 0 && i !== daily.length - 1) return null;
            return (
              <text
                key={`lbl-${d.business_date}`}
                x={xAt(i)}
                y={padding.top + innerH + 22}
                fontSize={12}
                textAnchor="middle"
                fill="rgb(71 85 105)"
              >
                {formatDayLabel(d.business_date, totalDays)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const rawStep = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  let step: number;
  if (norm >= 5) step = 10 * pow;
  else if (norm >= 2) step = 5 * pow;
  else if (norm >= 1) step = 2 * pow;
  else step = pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) {
    ticks.push(Math.round(v));
  }
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
