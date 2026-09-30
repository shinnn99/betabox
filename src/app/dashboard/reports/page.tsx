"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  PackageCheck,
  PackageX,
  Timer,
  HourglassIcon,
  ShieldCheck,
  Loader2,
  Video,
  FileWarning,
  Flag,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import DatePicker from "@/components/ui/DatePicker";
import DayShapeChart from "@/components/reports/DayShapeChart";
import PaceBandChart from "@/components/reports/PaceBandChart";
import VolumeChart from "@/components/reports/VolumeChart";
import InfoDot from "@/components/reports/InfoDot";

type RangeKey = "7d" | "30d" | "90d";

interface PaceStats {
  p50_seconds: number | null;
  p90_seconds: number | null;
  avg_seconds: number | null;
  measured_orders: number;
  valid_orders: number;
  measured_share: number;
}

interface DailyPoint {
  business_date: string;
  valid: number;
  duplicated: number;
  problems: number;
  capped: number;
  p50_seconds: number | null;
  p90_seconds: number | null;
  measured_orders: number;
  first_scan_at: string | null;
  last_scan_at: string | null;
  returns: number;
}

interface HourlyPoint {
  hour: number;
  outbound: number;
  returns: number;
  recording_hours: number;
}

interface StationStat {
  station_id: string | null;
  station_name: string;
  valid_orders: number;
  capped_orders: number;
  pace: PaceStats;
}

interface StaffStat {
  staff_id: string | null;
  full_name: string;
  valid_orders: number;
  duplicated_orders: number;
  capped_orders: number;
  active_days: number;
  worked_hours: number;
  orders_per_hour: number | null;
  stale_sessions: number;
  pace: PaceStats;
}

/** Luồng hoàn — đếm riêng, không cộng vào sản lượng đóng hàng. */
interface ReturnStaffStat {
  staff_id: string | null;
  full_name: string;
  valid_orders: number;
  duplicated_orders: number;
  active_days: number;
  capped_orders: number;
  pace: PaceStats;
}

interface EvidenceHealth {
  last_recording_date: string | null;
  recording_hours_last_day: number | null;
  days_without_recording: number;
  clips_ready: number;
  clips_failed: number;
  clips_evicted: number;
  clips_pending: number;
  open_claims: number;
  overdue_claims: number;
}

interface OperationsReport {
  range: { from: string; to: string; days: number };
  totals: {
    valid: number;
    duplicated: number;
    problems: number;
    capped: number;
    returns: number;
    capped_share: number;
    pace: PaceStats;
  };
  previous: { valid: number; capped_share: number; pace: PaceStats };
  daily: DailyPoint[];
  hourly: HourlyPoint[];
  stations: StationStat[];
  staff: StaffStat[];
  return_staff: ReturnStaffStat[];
  evidence: EvidenceHealth;
}

const RANGE_LABEL: Record<RangeKey, string> = {
  "7d": "7 ngày",
  "30d": "30 ngày",
  "90d": "90 ngày",
};

function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const t = Math.round(seconds);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  const s = t % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function fmtVnDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function pctDelta(current: number, previous: number): number | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  if (previous === 0) return current > 0 ? 100 : undefined;
  return Math.round(((current - previous) / previous) * 100);
}

function todayKey(): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + 7 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function shiftKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export default function ReportsPage() {
  const [preset, setPreset] = useState<RangeKey | null>("7d");
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => {
    const to = todayKey();
    return { from: shiftKey(to, -6), to };
  });
  const [data, setData] = useState<OperationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(
    () => (preset ? `range=${preset}` : `from=${custom.from}&to=${custom.to}`),
    [preset, custom],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/reports/operations?${query}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.message || `HTTP ${r.status}`);
        }
        return (await r.json()) as OperationsReport;
      })
      .then((d) => {
        if (!controller.signal.aborted) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [query]);

  const t = data?.totals;
  const prev = data?.previous;
  const ev = data?.evidence;
  const lastDay = data?.daily?.[data.daily.length - 1];

  const deltaVolume = t && prev ? pctDelta(t.valid, prev.valid) : undefined;
  const measuredPct = t ? Math.round(t.pace.measured_share * 100) : null;
  const cappedPct = t ? Math.round(t.capped_share * 100) : null;
  const prevCappedPct = prev ? Math.round(prev.capped_share * 100) : null;

  const recordingStale =
    ev?.last_recording_date != null && ev.last_recording_date < todayKey();

  return (
    <DashboardLayout
      pageTitle="Báo cáo vận hành"
      pageSubtitle="Nhịp làm việc, điểm nghẽn và sức khoẻ bằng chứng của kho"
      pageIcon={BarChart3}
    >
      <div className="space-y-3">
        {/* Bộ chọn khoảng */}
        <div className="bg-white rounded-2xl border border-slate-100 p-3 lg:p-4 shadow-sm flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((r) => (
              <button
                key={r}
                onClick={() => setPreset(r)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  preset === r
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <DatePicker
              value={custom.from}
              max={custom.to}
              ariaLabel="Từ ngày"
              onChange={(v) => {
                setCustom((c) => ({ ...c, from: v }));
                setPreset(null);
              }}
            />
            <span className="text-slate-400 text-sm">→</span>
            <DatePicker
              value={custom.to}
              min={custom.from}
              max={todayKey()}
              ariaLabel="Đến ngày"
              onChange={(v) => {
                setCustom((c) => ({ ...c, to: v }));
                setPreset(null);
              }}
            />
          </div>

          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang tải…
            </span>
          )}
          {error && <span className="text-xs text-rose-600">Lỗi: {error}</span>}
          {data && !loading && (
            <span className="ml-auto text-xs text-slate-500">
              {fmtVnDate(data.range.from)} → {fmtVnDate(data.range.to)} · {data.range.days} ngày
            </span>
          )}
        </div>

        {/* Năm ô tình hình. Đơn đi và kiện hoàn đứng RIÊNG, không cộng gộp. */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard
            label="Sản lượng đóng hàng"
            hint="Số đơn đóng hàng hợp lệ. Không tính lượt quét trùng, quét khi chưa vào ca, mã sai. Kiện hoàn đếm riêng ở ô bên."
            value={t ? t.valid.toLocaleString("vi-VN") : "—"}
            unit="đơn"
            icon={PackageCheck}
            tone="emerald"
            delta={deltaVolume}
            lines={[
              lastDay ? `${lastDay.valid} đơn ngày gần nhất` : "",
              t && t.duplicated > 0 ? `${t.duplicated} lượt quét trùng` : "",
            ]}
          />
          <KpiCard
            label="Tổng đơn hoàn"
            hint="Số kiện hoàn đã nhận và quay bằng chứng. Đếm riêng, không cộng vào sản lượng đóng hàng."
            value={t ? t.returns.toLocaleString("vi-VN") : "—"}
            unit="kiện"
            icon={PackageX}
            tone="amber"
            lines={[
              "đếm riêng, không cộng vào sản lượng đóng hàng",
              ev && ev.open_claims > 0 ? `${ev.open_claims} khiếu nại đang mở` : "",
            ]}
          />
          <KpiCard
            label="Nhịp xử lý"
            hint="Thời gian xử lý một đơn ở mức thường gặp: nửa số đơn nhanh hơn mức này. Dùng thay trung bình vì trung bình bị vài đơn cá biệt kéo lệch."
            value={t ? fmtDuration(t.pace.p50_seconds) : "—"}
            unit="p50"
            icon={Timer}
            tone="violet"
            lines={[
              t ? `p90 ${fmtDuration(t.pace.p90_seconds)} — cứ 10 đơn có 1 đơn lâu hơn` : "",
              measuredPct !== null
                ? `đo trên ${measuredPct}% số đơn (${t!.pace.measured_orders.toLocaleString("vi-VN")}/${t!.pace.valid_orders.toLocaleString("vi-VN")})`
                : "",
            ]}
          />
          <KpiCard
            label="Đơn hết giờ chờ"
            hint="Tỉ lệ đơn không có lượt quét kế tiếp nên hệ phải ép thời gian thay vì đo thật. Tỉ lệ cao thì số liệu thời gian chỉ phản ánh được một phần công việc."
            value={cappedPct !== null ? `${cappedPct}%` : "—"}
            unit={t ? `${t.capped.toLocaleString("vi-VN")} đơn` : ""}
            icon={HourglassIcon}
            tone={cappedPct !== null && cappedPct >= 20 ? "amber" : "slate"}
            delta={
              cappedPct !== null && prevCappedPct !== null
                ? -(cappedPct - prevCappedPct)
                : undefined
            }
            lines={[
              "không có lượt quét kế tiếp nên thời gian bị ép cứng",
              "nhân viên quên quét đơn tiếp theo hoặc ra ca giữa chừng",
            ]}
          />
          <KpiCard
            label="Bằng chứng"
            hint="Số giờ camera ghi được trong ngày gần nhất. Đỏ khi có ngày đứt ghi — những ngày đó đơn hàng không có video bằng chứng."
            value={
              ev?.recording_hours_last_day != null
                ? `${ev.recording_hours_last_day}h`
                : "—"
            }
            unit="ghi hình ngày gần nhất"
            icon={ShieldCheck}
            tone={recordingStale || (ev?.days_without_recording ?? 0) > 0 ? "rose" : "emerald"}
            lines={[
              ev?.last_recording_date
                ? `mới nhất ${fmtVnDate(ev.last_recording_date)}`
                : "chưa có file ghi hình nào",
              ev && ev.days_without_recording > 0
                ? `${ev.days_without_recording} ngày trong khoảng không ghi được`
                : "phủ đủ mọi ngày trong khoảng",
            ]}
          />
        </div>

        {/* Cảnh báo — chỉ hiện khi có thật */}
        {ev && (ev.overdue_claims > 0 || ev.days_without_recording > 0 || ev.clips_failed > 0) && (
          <div className="space-y-1.5">
            {ev.overdue_claims > 0 && (
              <AlertRow
                icon={Flag}
                text={`${ev.overdue_claims} khiếu nại hoàn đã quá hạn xử lý (tổng ${ev.open_claims} đang mở)`}
              />
            )}
            {ev.days_without_recording > 0 && (
              <AlertRow
                icon={Video}
                text={`${ev.days_without_recording} ngày trong khoảng không có file ghi hình nào — đơn của những ngày đó không có bằng chứng`}
              />
            )}
            {ev.clips_failed > 0 && (
              <AlertRow
                icon={FileWarning}
                text={`${ev.clips_failed} clip cắt lỗi trong khoảng${ev.clips_evicted > 0 ? `, ${ev.clips_evicted} clip đã hết hạn lưu` : ""}`}
              />
            )}
          </div>
        )}

        {/* Một ngày ở kho */}
        <Panel
          title="Một ngày ở kho"
          subtitle="Đơn dồn vào giờ nào, và camera có chạy đúng những giờ đó không"
        >
          {!data || data.hourly.length === 0 ? (
            <EmptyBox loading={loading} />
          ) : (
            <DayShapeChart hourly={data.hourly} />
          )}
        </Panel>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <Panel
            title="Sản lượng đóng hàng theo ngày"
          hint="Số đơn đóng mỗi ngày. Phần nhạt là đơn bị ép thời gian — vẫn tính sản lượng, nhưng không dùng đánh giá năng suất."
            subtitle="Phần nhạt là đơn bị ép thời gian vì không có lượt quét kế tiếp"
          >
            {!data || data.daily.length === 0 ? (
              <EmptyBox loading={loading} />
            ) : (
              <VolumeChart daily={data.daily} />
            )}
          </Panel>

          <Panel
            title="Nhịp xử lý theo ngày"
          hint="Thời gian xử lý thay đổi thế nào qua từng ngày. Ngày không đo được đơn nào thì bỏ trống, không nối đường qua."
            subtitle="Dải p50 → p90. Ngày không đo được đơn nào thì để trống, không nối."
          >
            {!data || data.daily.length === 0 ? (
              <EmptyBox loading={loading} />
            ) : (
              <PaceBandChart daily={data.daily} />
            )}
          </Panel>
        </div>

        {/* Hàng hoàn có biểu đồ RIÊNG — không cộng vào sản lượng đóng hàng. */}
        <Panel
          title="Sản lượng hoàn hàng theo ngày"
          hint="Số kiện hoàn nhận mỗi ngày. Để riêng chứ không chồng vào sản lượng đóng hàng — hai nghiệp vụ khác nhau."
          subtitle="Đếm riêng, không cộng vào sản lượng đóng hàng"
        >
          {!data || data.daily.length === 0 ? (
            <EmptyBox loading={loading} />
          ) : (
            <VolumeChart
              daily={data.daily.map((d) => ({
                business_date: d.business_date,
                valid: d.returns,
                duplicated: 0,
                problems: 0,
                capped: 0,
              }))}
              tone="amber"
              unitLabel="kiện hoàn"
              showCapped={false}
            />
          )}
        </Panel>

        {/* Theo bàn */}
        <Panel
          title="Theo bàn đóng hàng"
          hint="So các bàn để tìm điểm nghẽn. p90 cao hơn hẳn thường là bàn xa kệ, thiếu dụng cụ hoặc chuyên hàng cồng kềnh."
          subtitle="Bàn nào chậm hơn, bàn nào hay bị bỏ dở giữa chừng"
        >
          <StationTable stations={data?.stations ?? []} loading={loading} />
        </Panel>

        {/* Theo nhân sự — MỘT khung bảng, hai luồng, không bao giờ lệch cột. */}
        <StaffReportTable
          title="Báo cáo đóng hàng theo nhân sự"
          hint="Năng suất tính trên giờ có mặt thật, không chia đều theo ngày. Quên ra ca làm giờ ghi nhận dài hơn thực tế, kéo năng suất trông thấp đi."
          subtitle="Năng suất tính trên giờ có mặt thật, lấy từ phiên làm việc — không phải chia đều theo ngày"
          staff={data?.staff ?? []}
          loading={loading}
          showWorkHours
        />

        <StaffReportTable
          title="Báo cáo hoàn hàng theo nhân sự"
          hint="p50/p90 đo thời gian mở kiện quay bằng chứng. Bỏ nhóm hết-giờ-chờ khỏi hai số này vì đó là số bị ép bằng trần, không phải đo thật."
          subtitle="Kiện hoàn đếm riêng. Không có cột giờ làm vì nhân viên vào ca một lần rồi làm cả hai luồng, không quy riêng được."
          staff={(data?.return_staff ?? []).map((s) => ({
            staff_id: s.staff_id,
            full_name: s.full_name,
            valid_orders: s.valid_orders,
            duplicated_orders: s.duplicated_orders,
            capped_orders: s.capped_orders,
            active_days: s.active_days,
            // Ba ô này bị ẩn hẳn ở luồng hoàn (showWorkHours=false).
            worked_hours: 0,
            orders_per_hour: null,
            stale_sessions: 0,
            pace: s.pace,
          }))}
          loading={loading}
          unitLabel="kiện"
        />

        {/* Bằng chứng */}
        <Panel
          title="Kho bằng chứng"
          hint="Video bằng chứng cắt được bao nhiêu, hỏng bao nhiêu, còn bao nhiêu khiếu nại chờ xử lý."
          subtitle="Clip cắt ra dùng được bao nhiêu, và còn bao nhiêu khiếu nại chờ xử lý"
        >
          {!ev ? (
            <EmptyBox loading={loading} />
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <MiniStat
                label="Clip sẵn sàng"
                value={ev.clips_ready}
                tone="emerald"
                tip="Clip đã cắt xong, mở xem được ngay. Đây là những đơn có video đưa cho khách khi tranh chấp."
              />
              <MiniStat
                label="Đang cắt"
                value={ev.clips_pending}
                tone="slate"
                tip="Đã đặt lệnh cắt, máy kho đang xử lý. Đứng yên nhiều giờ nghĩa là máy kho hoặc mạng có vấn đề."
              />
              <MiniStat
                label="Cắt lỗi"
                value={ev.clips_failed}
                tone="rose"
                tip="Cắt không thành: video gốc đã xoá theo hạn lưu, file hỏng, hoặc camera không ghi lúc đó. Đơn này không có bằng chứng."
              />
              <MiniStat
                label="Hết hạn lưu"
                value={ev.clips_evicted}
                tone="slate"
                tip="Đã cắt xong nhưng bị xoá vì quá số ngày giữ video. Bình thường — cơ chế dọn ổ đĩa, không phải lỗi."
              />
              <MiniStat
                label="Khiếu nại đang mở"
                value={ev.open_claims}
                tone={ev.overdue_claims > 0 ? "rose" : "amber"}
                hint={ev.overdue_claims > 0 ? `${ev.overdue_claims} quá hạn` : undefined}
                tip="Hồ sơ khiếu nại chưa xử lý xong. Mỗi hồ sơ có hạn gửi lên sàn, quá hạn là mất quyền đòi bồi thường."
              />
            </div>
          )}
        </Panel>
      </div>
    </DashboardLayout>
  );
}

function Panel({
  title,
  subtitle,
  children,
  hint,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  /** Giải thích khối này trả lời câu hỏi gì, hiện khi rê chuột vào tiêu đề. */
  hint?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
      <div className="mb-4">
        <p className="text-sm font-semibold text-slate-800">
          {title}
          <InfoDot hint={hint} />
        </p>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function EmptyBox({ loading }: { loading: boolean }) {
  return (
    <div className="h-48 flex items-center justify-center text-sm text-slate-400">
      {loading ? "Đang tải dữ liệu…" : "Chưa có dữ liệu trong khoảng này"}
    </div>
  );
}

function AlertRow({
  icon: Icon,
  text,
}: {
  icon: typeof Flag;
  text: string;
}) {
  return (
    <div className="bg-amber-50 border-l-4 border-amber-400 text-amber-900 text-sm rounded-r-xl px-4 py-2.5 flex items-start gap-2.5">
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
      <span className="leading-snug">{text}</span>
    </div>
  );
}

const KPI_TONE = {
  emerald: { bg: "bg-emerald-50", ring: "ring-emerald-100", text: "text-emerald-600" },
  violet: { bg: "bg-violet-50", ring: "ring-violet-100", text: "text-violet-600" },
  amber: { bg: "bg-amber-50", ring: "ring-amber-100", text: "text-amber-600" },
  rose: { bg: "bg-rose-50", ring: "ring-rose-100", text: "text-rose-600" },
  slate: { bg: "bg-slate-50", ring: "ring-slate-100", text: "text-slate-500" },
} as const;

/**
 * Ô KPI có chỗ cho HAI dòng chú thích — khác StatCard dùng chung (một dòng
 * hint). Mọi số thời gian ở trang này bắt buộc đi kèm mẫu số "đo trên N% số
 * đơn", nên chỗ chú thích là phần bắt buộc chứ không phải trang trí.
 */
function KpiCard({
  label,
  value,
  unit,
  icon: Icon,
  tone,
  delta,
  lines,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: typeof PackageCheck;
  tone: keyof typeof KPI_TONE;
  delta?: number;
  lines?: string[];
  /** Giải thích chỉ số đếm cái gì, hiện khi rê chuột vào nhãn. */
  hint?: string;
}) {
  const s = KPI_TONE[tone];
  const up = (delta ?? 0) >= 0;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm flex flex-col">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-slate-500 tracking-wide">
            {label}
            <InfoDot hint={hint} />
          </p>
          <p className="text-2xl lg:text-[28px] font-extrabold text-slate-900 mt-1.5 leading-none tracking-tight">
            {value}
            {unit && (
              <span className="text-sm font-semibold text-slate-400 ml-1.5">{unit}</span>
            )}
          </p>
        </div>
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ring-1 shrink-0 ${s.bg} ${s.ring}`}>
          <Icon className={`h-5 w-5 ${s.text}`} />
        </div>
      </div>
      <div className="mt-3 space-y-1">
        {typeof delta === "number" && (
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-semibold ${
              up ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            }`}
          >
            {up ? "+" : ""}
            {delta}% so với kỳ trước
          </span>
        )}
        {lines?.filter(Boolean).map((line) => (
          <p key={line} className="text-[11px] leading-snug text-slate-500">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
  hint,
  tip,
}: {
  label: string;
  value: number;
  tone: keyof typeof KPI_TONE;
  /** Dòng chữ nhỏ hiện sẵn dưới con số. */
  hint?: string;
  /** Giải thích đầy đủ, hiện khi rê chuột vào nhãn. */
  tip?: string;
}) {
  const s = KPI_TONE[tone];
  return (
    <div className={`rounded-xl px-3 py-2.5 ring-1 ${s.bg} ${s.ring}`}>
      <p className="text-[11px] font-medium text-slate-500">
        {label}
        <InfoDot hint={tip} />
      </p>
      <p className={`text-xl font-bold mt-0.5 ${s.text}`}>{value.toLocaleString("vi-VN")}</p>
      {hint && <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>}
    </div>
  );
}

/** Thanh tỉ lệ nhỏ — đọc nhanh hơn con số phần trăm đứng một mình. */
function RateBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const tone = pct >= 30 ? "bg-rose-400" : pct >= 15 ? "bg-amber-400" : "bg-slate-300";
  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="font-mono text-slate-600 tabular-nums">{pct.toFixed(0)}%</span>
      <span className="h-1.5 w-12 rounded-full bg-slate-100 overflow-hidden shrink-0">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
    </div>
  );
}

/**
 * Ô tiêu đề cột có giải thích khi rê chuột. Gạch chấm dưới chữ để người dùng
 * biết là rê được — không có dấu hiệu đó thì tooltip coi như không tồn tại.
 */
function Th({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <th className="px-3 py-2.5 font-semibold text-right first:text-left">
      <span className="whitespace-nowrap">
        {children}
        <InfoDot hint={hint} />
      </span>
    </th>
  );
}

function StationTable({
  stations,
  loading,
}: {
  stations: StationStat[];
  loading: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] tracking-wider text-slate-500 border-b border-slate-100">
            <Th>Bàn</Th>
            <Th hint="Số đơn hợp lệ ghi nhận tại bàn này.">
              Số đơn
            </Th>
            <Th hint="Nửa số đơn của bàn này nhanh hơn mức đó. So giữa các bàn để biết bàn nào chậm hơn.">
              p50
            </Th>
            <Th hint="Cứ 10 đơn thì có 1 đơn chậm hơn mức này. Cách xa p50 nghĩa là nhiều đơn khó hoặc hay bị gián đoạn.">
              p90
            </Th>
            <Th hint="Tỉ lệ đơn bị ép thời gian vì thiếu lượt quét kế tiếp. Cao thường là bàn làm lai rai, không liên tục.">
              Hết giờ chờ
            </Th>
            <Th hint="Số đơn đo được thật trên tổng số đơn — mẫu số của p50 và p90.">
              Đo được
            </Th>
          </tr>
        </thead>
        <tbody>
          {stations.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">
                {loading ? "Đang tải…" : "Không có dữ liệu"}
              </td>
            </tr>
          ) : (
            stations.map((s, i) => (
              <tr
                key={s.station_id ?? `none-${i}`}
                className="border-t border-slate-100 hover:bg-slate-50/60"
              >
                <td className="px-3 py-2.5 font-medium text-slate-800">{s.station_name}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-700 tabular-nums">
                  {s.valid_orders.toLocaleString("vi-VN")}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-700 tabular-nums">
                  {fmtDuration(s.pace.p50_seconds)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-600 tabular-nums">
                  {fmtDuration(s.pace.p90_seconds)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <RateBar value={s.capped_orders} total={s.valid_orders} />
                </td>
                <td className="px-3 py-2.5 text-right text-xs text-slate-500 tabular-nums">
                  {s.pace.measured_orders}/{s.pace.valid_orders}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Bảng theo nhân sự — MỘT khung cho cả hai luồng.
 *
 * Chủ dự án chốt 23/09/2026: "bảng của hoàn hàng viết y nguyên các thuộc tính
 * như đóng hàng". Một component thì không bao giờ lệch cột. Luồng hoàn truyền
 * vào các ô nhịp bằng null — bảng tự hiện "—" thay vì bịa số.
 *
 * Cột nào luồng đó KHÔNG có thì ẩn hẳn (`showWorkHours`), không để một cột
 * toàn dấu gạch: cột trống vẫn chiếm chỗ và bắt người đọc dừng lại hỏi tại
 * sao, trong khi câu trả lời là "luồng này không có khái niệm đó".
 */
function StaffReportTable({
  title,
  subtitle,
  staff,
  loading,
  unitLabel = "đơn",
  showWorkHours = false,
  hint,
}: {
  title: string;
  subtitle: string;
  staff: StaffStat[];
  loading: boolean;
  unitLabel?: string;
  /**
   * Ba cột giờ-làm chỉ có ở luồng đóng hàng. Nhân viên vào ca MỘT lần rồi vừa
   * đóng hàng vừa nhận hoàn, nên giờ làm là chung cho cả hai luồng — không
   * quy riêng cho hàng hoàn được. Bỏ hẳn cột thay vì để một cột toàn dấu gạch.
   */
  showWorkHours?: boolean;
  /** Giải thích bảng này đọc thế nào, hiện khi rê chuột vào tiêu đề. */
  hint?: string;
}) {
  const cols = showWorkHours ? 8 : 5;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="p-4 lg:p-5 border-b border-slate-100">
        <p className="text-sm font-semibold text-slate-800">
          {title}
          <InfoDot hint={hint} />
        </p>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] tracking-wider text-slate-500 border-b border-slate-100">
            <Th>Thành viên</Th>
            <Th hint={`Số ${unitLabel} hợp lệ người này xử lý trong khoảng đang xem. Lượt quét trùng ghi riêng cạnh tên, không cộng vào đây.`}>
              Số {unitLabel}
            </Th>
            {showWorkHours && (
              <>
                <Th hint="Giờ có mặt thật, cộng từ các phiên vào/ra ca — không phải số ngày nhân 8.">
                  Giờ làm
                </Th>
                <Th hint={`Số ${unitLabel} chia cho giờ có mặt thật. Công bằng hơn "${unitLabel}/ngày": người làm nửa buổi không bị so ngang với người làm cả ngày.`}>
                  {unitLabel === "đơn" ? "Đơn/giờ" : `${unitLabel}/giờ`}
                </Th>
              </>
            )}
            <Th hint={`Nửa số ${unitLabel} của người này nhanh hơn mức đó.`}>
              p50
            </Th>
            <Th hint={`Cứ 10 ${unitLabel} thì có 1 cái chậm hơn mức này. Cách xa p50 nghĩa là làm không đều tay.`}>
              p90
            </Th>
            <Th hint={`Tỉ lệ ${unitLabel} bị ép thời gian vì hết giờ chờ, hệ không đo được thật. Không tính vào p50/p90.`}>
              Hết giờ chờ
            </Th>
            {showWorkHours && (
              <Th hint="Số phiên bị hệ tự đóng vì quên quét mã ra ca. Nhiều lần thì giờ làm ghi nhận dài hơn thực tế.">
                Quên ra ca
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {staff.length === 0 ? (
            <tr>
              <td colSpan={cols} className="px-3 py-8 text-center text-sm text-slate-400">
                {loading ? "Đang tải…" : "Không có dữ liệu"}
              </td>
            </tr>
          ) : (
            staff.map((s, i) => (
              <tr
                key={s.staff_id ?? `none-${i}`}
                className="border-t border-slate-100 hover:bg-slate-50/60"
              >
                <td className="px-3 py-2.5 font-medium text-slate-800">
                  {s.full_name}
                  {s.duplicated_orders > 0 && (
                    <span className="ml-2 text-[11px] text-slate-400">
                      {s.duplicated_orders} lượt trùng
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-700 tabular-nums">
                  {s.valid_orders.toLocaleString("vi-VN")}
                </td>
                {showWorkHours && (
                  <>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-600 tabular-nums">
                      {s.worked_hours > 0 ? `${s.worked_hours}h` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-800 tabular-nums">
                      {s.orders_per_hour ?? "—"}
                    </td>
                  </>
                )}
                <td className="px-3 py-2.5 text-right font-mono text-slate-700 tabular-nums">
                  {fmtDuration(s.pace.p50_seconds)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-600 tabular-nums">
                  {fmtDuration(s.pace.p90_seconds)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {/* Mẫu số là số đã đóng (đo được + bị ép), không phải tổng —
                      kiện còn đang mở chưa có thời lượng nào để nói tới. */}
                  {s.pace.valid_orders > 0 ? (
                    <RateBar value={s.capped_orders} total={s.pace.valid_orders} />
                  ) : (
                    <span className="font-mono text-slate-400">—</span>
                  )}
                </td>
                {showWorkHours && (
                  <td
                    className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                      s.stale_sessions > 0 ? "text-amber-600 font-semibold" : "text-slate-400"
                    }`}
                  >
                    {s.stale_sessions > 0 ? s.stale_sessions : "—"}
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
