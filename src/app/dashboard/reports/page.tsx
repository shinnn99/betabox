"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  TrendingUp,
  Calendar,
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
  active_days: number;
  avg_videos_per_day: number;
  avg_duration_seconds: number | null;
}

interface PerformanceSummary {
  range: RangeKey;
  from: string;
  to: string;
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

function formatDayLabel(iso: string, range: RangeKey): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (range === "7d") return WEEKDAY_LABEL[d.getUTCDay()];
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface FetchState {
  status: "idle" | "loading" | "success" | "error";
  data: PerformanceSummary | null;
  error: string | null;
}

export default function ReportsPage() {
  const [range, setRange] = useState<RangeKey>("7d");
  const [state, setState] = useState<FetchState>({
    status: "loading",
    data: null,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();

    const run = async () => {
      setState((prev) => ({ status: "loading", data: prev.data, error: null }));
      try {
        const r = await fetch(`/api/reports/performance?range=${range}`, {
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
  }, [range]);

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

  return (
    <DashboardLayout
      pageTitle="Báo cáo hiệu suất"
      pageSubtitle="Tổng quan sản lượng, thời gian xử lý & tỷ lệ chuẩn xác"
      pageIcon={BarChart3}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 p-3 lg:p-4 shadow-sm flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  range === r
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          <button className="h-9 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-2 text-sm text-slate-700">
            <Calendar className="h-4 w-4" /> Tuỳ chỉnh khoảng
          </button>
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
            label={`Tổng đơn (${RANGE_LABEL[range]})`}
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
            <DailyLineChart daily={daily} range={range} />
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
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold text-right">Số video đóng hàng</th>
                  <th className="px-4 py-3 font-semibold text-right">Số đơn</th>
                  <th className="px-4 py-3 font-semibold text-right">Số đơn lặp</th>
                  <th className="px-4 py-3 font-semibold text-right">TB video/ngày</th>
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
                  staff.map((s, idx) => (
                    <tr
                      key={s.staff_id ?? `unassigned-${idx}`}
                      className="border-t border-slate-100 hover:bg-slate-50/60"
                    >
                      <td className="px-4 py-3 font-medium text-slate-800">{s.full_name}</td>
                      <td className="px-4 py-3 text-slate-600">{s.email ?? "—"}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-slate-800">
                        {s.video_count.toLocaleString("vi-VN")}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {s.valid_orders.toLocaleString("vi-VN")}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-600">
                        {s.duplicated_orders.toLocaleString("vi-VN")}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {s.avg_videos_per_day.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-600">
                        {formatDuration(s.avg_duration_seconds)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function DailyLineChart({ daily, range }: { daily: DailyPoint[]; range: RangeKey }) {
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

  const maxValue = Math.max(1, ...daily.map((d) => Math.max(d.valid, d.duplicated)));
  const ticks = niceTicks(maxValue, 4);
  const tickMax = ticks[ticks.length - 1];

  const stepX = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const xAt = (i: number) => padding.left + stepX * i;
  const yAt = (v: number) => padding.top + innerH - (v / tickMax) * innerH;

  const buildPath = (key: "valid" | "duplicated") =>
    daily
      .map((d, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(d[key]).toFixed(2)}`)
      .join(" ");

  const buildArea = (key: "valid" | "duplicated") => {
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
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
          <span className="text-slate-600">Đơn lặp</span>
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
            stroke="rgb(244 63 94)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {daily.map((d, i) => (
            <g key={`pts-${d.business_date}`}>
              <circle cx={xAt(i)} cy={yAt(d.valid)} r={3} fill="rgb(16 185 129)" />
              <circle cx={xAt(i)} cy={yAt(d.duplicated)} r={3} fill="rgb(244 63 94)" />
              <title>
                {`${d.business_date} · Đơn: ${d.valid} · Lặp: ${d.duplicated}`}
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
                {formatDayLabel(d.business_date, range)}
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
