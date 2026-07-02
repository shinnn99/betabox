"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Camera,
  CheckCircle2,
  Circle,
  Clock,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  Package,
  Play,
  RefreshCcw,
  RotateCw,
  Search,
  Timer,
  User,
  Video,
  Warehouse as WarehouseIcon,
  X,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import DateRangePicker from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";

interface ScanRow {
  id: string;
  waybill_code: string;
  scanned_at: string;
  status: string;
  assignment_method: string;
  timing_status: string;
  work_duration_seconds: number | null;
  station: { id: string; code: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
  staff: { id: string; full_name: string; staff_code: string } | null;
  camera: { id: string; camera_code: string; name: string } | null;
  clip: {
    id: string;
    status: "pending" | "ready" | "failed";
    duration_seconds: number | null;
    // Business window (scan_at − pre … next_scan − before_next).
    target_duration_seconds: number | null;
    // What ffmpeg was asked to cut: target ± GOP buffer for copy mode.
    cut_duration_seconds: number | null;
    target_started_at: string | null;
    target_ended_at: string | null;
    // Actual video timestamps (target ± GOP buffer). Used for display so
    // the bắt đầu / kết thúc / tổng numbers all agree with the player.
    cut_started_at: string | null;
    cut_ended_at: string | null;
    clip_size_bytes: number | null;
    error_message: string | null;
    generated_at: string | null;
    transcoded_for_browser: boolean;
  } | null;
}

// Format an ISO timestamp as a Vietnamese HH:mm:ss — used in the detail
// panel where the date is already obvious from context.
function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("vi-VN", { hour12: false });
}

// Anchor the displayed "video bắt đầu" to (cut_ended_at − duration_seconds)
// instead of cut_started_at. ffmpeg's -c copy snaps the seek-in point to
// the nearest keyframe at or after cutStart, so the file's true first
// frame is usually a second or two later than cutStart — but it always
// stops at -t, so cut_ended_at is reliable. Anchoring on the end means
// the three numbers shown to the user (bắt đầu, kết thúc, tổng) agree
// exactly with the player's 0:00 / 0:NN readout.
function videoStartFromEnd(
  endIso: string | null,
  durationSeconds: number | null,
): string | null {
  if (!endIso || durationSeconds == null) return null;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return null;
  return new Date(end.getTime() - durationSeconds * 1000).toISOString();
}

// Build a multi-line tooltip explaining the duration breakdown.
// `actual` is what plays, `target` is the business window, `cut` is what
// we asked ffmpeg for. If buffer was applied, `cut` > `target`.
function clipDurationTooltip(c: {
  duration_seconds: number | null;
  target_duration_seconds: number | null;
  cut_duration_seconds: number | null;
}): string {
  const parts: string[] = [];
  if (c.duration_seconds != null) parts.push(`Video: ${c.duration_seconds}s`);
  if (c.target_duration_seconds != null) {
    parts.push(`Window đơn hàng: ${c.target_duration_seconds}s`);
  }
  if (
    c.cut_duration_seconds != null &&
    c.target_duration_seconds != null &&
    c.cut_duration_seconds > c.target_duration_seconds
  ) {
    const extra = c.cut_duration_seconds - c.target_duration_seconds;
    parts.push(`Buffer cắt: +${extra}s để tránh keyframe trim`);
  }
  return parts.join("\n");
}

type ViewMode = "list" | "grid";

// "2026-06-28" -> Date at local 00:00 / 23:59:59.999.
function dayStart(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function dayEnd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  const mb = n / 1024 / 1024;
  if (mb < 0.1) return `${(n / 1024).toFixed(0)} KB`;
  return `${mb.toFixed(2)} MB`;
}

function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

const CLIP_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ready: { label: "Sẵn sàng", cls: "bg-emerald-50 text-emerald-700" },
  pending: { label: "Đang xử lý", cls: "bg-blue-50 text-blue-700" },
  failed: { label: "Lỗi", cls: "bg-rose-50 text-rose-700" },
};

const PAGE_LIMIT = 50;

export default function VideosPage() {
  const toast = useToast();

  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [waybillSearch, setWaybillSearch] = useState("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const [rows, setRows] = useState<ScanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [playing, setPlaying] = useState<ScanRow | null>(null);
  const [busy, setBusy] = useState<Record<string, "generate" | "regenerate" | null>>(
    {},
  );

  // Sum of clip_size_bytes across the rows currently loaded. When the
  // list is paginated (hasMore=true) this is a lower bound — we surface
  // that with a trailing "+" in the header.
  const totalClipBytes = useMemo(
    () =>
      rows.reduce((sum, r) => sum + (r.clip?.clip_size_bytes ?? 0), 0),
    [rows],
  );

  const buildQuery = useCallback(
    (off: number) => {
      const params = new URLSearchParams();
      if (from) params.set("from", dayStart(from).toISOString());
      if (to) params.set("to", dayEnd(to).toISOString());
      if (waybillSearch.trim()) params.set("waybill_code", waybillSearch.trim());
      params.set("scan_status", "valid");
      params.set("limit", String(PAGE_LIMIT));
      params.set("offset", String(off));
      return params.toString();
    },
    [from, to, waybillSearch],
  );

  const load = useCallback(
    async (mode: "fresh" | "more") => {
      const off = mode === "fresh" ? 0 : offset;
      if (mode === "fresh") setLoading(true);
      else setLoadingMore(true);

      const res = await fetch(
        `/api/order-proof/scans?${buildQuery(off)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (mode === "fresh") setLoading(false);
      else setLoadingMore(false);

      if (!res.ok) {
        toast.error(data.message ?? data.error ?? "Không tải được danh sách");
        return;
      }
      const incoming = (data.scans ?? []) as ScanRow[];
      const more = Boolean(data.has_more);
      if (mode === "fresh") {
        setRows(incoming);
        setOffset(incoming.length);
      } else {
        setRows((prev) => [...prev, ...incoming]);
        setOffset((prev) => prev + incoming.length);
      }
      setHasMore(more);
    },
    [buildQuery, offset, toast],
  );

  useEffect(() => {
    void load("fresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waybillSearch, from, to]);

  const onGenerate = async (scan: ScanRow, regenerate: boolean) => {
    setBusy((b) => ({ ...b, [scan.id]: regenerate ? "regenerate" : "generate" }));
    const res = await fetch(`/api/order-proof/scans/${scan.id}/clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regenerate }),
    });
    const data = await res.json();
    setBusy((b) => ({ ...b, [scan.id]: null }));
    if (!res.ok) {
      if (res.status === 425) {
        toast.info(data.message ?? "Video chưa sẵn sàng, thử lại sau.");
      } else {
        toast.error(data.message ?? data.error ?? "Tạo clip thất bại");
      }
    } else {
      toast.success(regenerate ? "Đã tạo lại clip" : "Đã tạo clip");
    }
    void load("fresh");
  };

  return (
    <DashboardLayout
      pageTitle="Kho bằng chứng giao hàng"
      pageSubtitle="Tra mã vận đơn để xem video lúc đóng hàng"
      pageIcon={Video}
    >
      <div className="space-y-3">
        <SearchBar
          waybillSearch={waybillSearch}
          setWaybillSearch={setWaybillSearch}
          from={from}
          to={to}
          onDateChange={(f, t) => {
            setFrom(f);
            setTo(t);
          }}
          viewMode={viewMode}
          setViewMode={setViewMode}
          onRefresh={() => load("fresh")}
        />

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
          <div className="px-4 lg:px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-800">
              {loading
                ? "Đang tải..."
                : `${rows.length} lần quét${hasMore ? "+" : ""}`}
            </p>
            <div className="flex items-center gap-3 text-[11px] text-slate-500">
              {(from || to) && (
                <span>
                  {from || "…"} → {to || "…"}
                </span>
              )}
              {!loading && totalClipBytes > 0 && (
                <span
                  className="inline-flex items-center gap-1"
                  title={
                    hasMore
                      ? "Tổng dung lượng của các clip đã tải trên trang. Còn dữ liệu chưa tải — tổng thực tế lớn hơn."
                      : "Tổng dung lượng của các clip trong danh sách hiện tại."
                  }
                >
                  <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                  <span className="font-mono text-slate-700">
                    {formatBytes(totalClipBytes)}
                    {hasMore ? "+" : ""}
                  </span>
                </span>
              )}
            </div>
          </div>

          {viewMode === "list" ? (
            <ListView
              loading={loading}
              rows={rows}
              busy={busy}
              onGenerate={(r) => onGenerate(r, false)}
              onRegenerate={(r) => onGenerate(r, true)}
              onPlay={setPlaying}
            />
          ) : (
            <GridView
              loading={loading}
              rows={rows}
              busy={busy}
              onGenerate={(r) => onGenerate(r, false)}
              onRegenerate={(r) => onGenerate(r, true)}
              onPlay={setPlaying}
            />
          )}

          {hasMore && !loading && (
            <div className="border-t border-slate-100 px-4 py-3 text-center">
              <button
                onClick={() => load("more")}
                disabled={loadingMore}
                className="h-9 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
              >
                {loadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
                Tải thêm
              </button>
            </div>
          )}
        </div>
      </div>

      {playing?.clip?.id && (
        <PlayerModal scan={playing} onClose={() => setPlaying(null)} />
      )}
    </DashboardLayout>
  );
}

function SearchBar(props: {
  waybillSearch: string;
  setWaybillSearch: (v: string) => void;
  from: string;
  to: string;
  onDateChange: (from: string, to: string) => void;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-3 lg:p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
          <input
            value={props.waybillSearch}
            onChange={(e) =>
              props.setWaybillSearch(e.target.value.toUpperCase())
            }
            placeholder="Tìm mã vận đơn..."
            className="w-full h-9 pl-9 pr-3 rounded-xl border border-slate-200 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
          />
        </div>

        <DateRangePicker
          from={props.from}
          to={props.to}
          onChange={({ from, to }) => props.onDateChange(from, to)}
          placeholder="Tất cả các ngày"
        />

        <div className="inline-flex items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          <button
            onClick={() => props.setViewMode("list")}
            className={`h-8 px-2.5 rounded-lg inline-flex items-center gap-1 text-xs font-semibold transition-colors ${
              props.viewMode === "list"
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Danh sách</span>
          </button>
          <button
            onClick={() => props.setViewMode("grid")}
            className={`h-8 px-2.5 rounded-lg inline-flex items-center gap-1 text-xs font-semibold transition-colors ${
              props.viewMode === "grid"
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Lưới</span>
          </button>
        </div>

        <button
          onClick={props.onRefresh}
          title="Làm mới"
          className="h-9 w-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center justify-center"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function ListView({
  loading,
  rows,
  busy,
  onGenerate,
  onRegenerate,
  onPlay,
}: {
  loading: boolean;
  rows: ScanRow[];
  busy: Record<string, "generate" | "regenerate" | null>;
  onGenerate: (r: ScanRow) => void;
  onRegenerate: (r: ScanRow) => void;
  onPlay: (r: ScanRow) => void;
}) {
  return (
    <div>
      <table className="w-full text-sm border-separate border-spacing-0">
        <thead>
          <tr className="bg-slate-50 text-left text-[11px] tracking-wider text-slate-500 sticky top-0 z-10 [&>th:first-child]:rounded-tl-2xl [&>th:last-child]:rounded-tr-2xl [&>th]:border-b [&>th]:border-slate-100">
            <th className="bg-slate-50 px-3 py-2.5 font-semibold w-40">Thời gian</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold w-44">Mã vận đơn</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold">Kho · Bàn</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold">Nhân viên</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold">Camera</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold w-28">T/g đóng đơn</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold">Clip</th>
            <th className="bg-slate-50 px-3 py-2.5 font-semibold text-right w-1">
              Hành động
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={8} className="px-3 py-10 text-center text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                Đang tải...
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={8}
                className="px-3 py-12 text-center text-slate-400 text-sm"
              >
                Không có lần quét nào khớp bộ lọc.
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((r) => (
              <ScanRowView
                key={r.id}
                scan={r}
                busy={busy[r.id] ?? null}
                onGenerate={() => onGenerate(r)}
                onRegenerate={() => onRegenerate(r)}
                onPlay={() => onPlay(r)}
              />
            ))}
        </tbody>
      </table>
    </div>
  );
}

function GridView({
  loading,
  rows,
  busy,
  onGenerate,
  onRegenerate,
  onPlay,
}: {
  loading: boolean;
  rows: ScanRow[];
  busy: Record<string, "generate" | "regenerate" | null>;
  onGenerate: (r: ScanRow) => void;
  onRegenerate: (r: ScanRow) => void;
  onPlay: (r: ScanRow) => void;
}) {
  if (loading) {
    return (
      <div className="px-3 py-16 text-center text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
        Đang tải...
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-3 py-16 text-center text-slate-400 text-sm">
        Không có lần quét nào khớp bộ lọc.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-3">
      {rows.map((r) => (
        <ScanCardView
          key={r.id}
          scan={r}
          busy={busy[r.id] ?? null}
          onGenerate={() => onGenerate(r)}
          onRegenerate={() => onRegenerate(r)}
          onPlay={() => onPlay(r)}
        />
      ))}
    </div>
  );
}

function ScanRowView({
  scan,
  busy,
  onGenerate,
  onRegenerate,
  onPlay,
}: {
  scan: ScanRow;
  busy: "generate" | "regenerate" | null;
  onGenerate: () => void;
  onRegenerate: () => void;
  onPlay: () => void;
}) {
  const clip = scan.clip;
  const clipBadge = clip ? CLIP_STATUS_LABEL[clip.status] : null;
  const clipReady = clip?.status === "ready";
  const clipFailed = clip?.status === "failed";

  return (
    <tr className="[&>td]:border-t [&>td]:border-slate-100 hover:bg-slate-50 align-top">
      <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">
        <div className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3 text-slate-400" />
          {new Date(scan.scanned_at).toLocaleString("vi-VN")}
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs font-semibold text-slate-800">
        {scan.waybill_code}
        {scan.timing_status === "open" && (
          <div className="text-[10px] text-blue-700 mt-1 font-sans">
            Đang đóng
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">
        <div className="inline-flex items-center gap-1">
          <WarehouseIcon className="h-3 w-3 text-slate-400" />
          {scan.warehouse?.name ?? "—"}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {scan.station ? `${scan.station.code} · ${scan.station.name}` : "—"}
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">
        {scan.staff ? (
          <div className="inline-flex items-center gap-1">
            <User className="h-3 w-3 text-slate-400" />
            <span>
              <span className="font-mono">{scan.staff.staff_code}</span>{" "}
              <span className="text-slate-500">·</span> {scan.staff.full_name}
            </span>
          </div>
        ) : (
          <span className="text-slate-400">Không có ca</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-700">
        {scan.camera ? (
          <div className="inline-flex items-center gap-1">
            <Camera className="h-3 w-3 text-slate-400" />
            <span className="font-mono">{scan.camera.camera_code}</span>
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-700">
        <div className="inline-flex items-center gap-1">
          <Timer className="h-3 w-3 text-slate-400" />
          {formatDuration(scan.work_duration_seconds)}
        </div>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {clipBadge ? (
          <>
            <span
              className={`text-[11px] font-semibold px-2 py-0.5 rounded ${clipBadge.cls}`}
            >
              {clipBadge.label}
            </span>
            {clipReady && (
              <div
                className="text-[10px] text-slate-500 mt-0.5"
                title={clipDurationTooltip(clip!)}
              >
                {formatDuration(clip!.duration_seconds)} ·{" "}
                {formatBytes(clip!.clip_size_bytes)}
              </div>
            )}
            {clipFailed && clip?.error_message && (
              <div
                className="text-[10px] text-rose-700 mt-0.5 max-w-[180px] truncate"
                title={clip.error_message}
              >
                {clip.error_message.split("\n")[0]}
              </div>
            )}
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <Circle className="h-3 w-3" /> Chưa có
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        <div className="inline-flex items-center justify-end gap-1">
          {clipReady ? (
            <>
              <button
                onClick={onPlay}
                className="h-8 px-2.5 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 inline-flex items-center gap-1 text-xs font-semibold"
              >
                <Play className="h-3 w-3" /> Xem
              </button>
              <button
                onClick={onRegenerate}
                disabled={busy !== null}
                className="h-8 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 text-xs font-semibold disabled:opacity-60"
              >
                {busy === "regenerate" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCw className="h-3 w-3" />
                )}
                Tạo lại
              </button>
            </>
          ) : (
            <button
              onClick={onGenerate}
              disabled={busy !== null}
              className="h-8 px-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 text-xs font-semibold disabled:opacity-60"
            >
              {busy === "generate" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {clipFailed ? "Thử lại" : "Tạo clip"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ScanCardView({
  scan,
  busy,
  onGenerate,
  onRegenerate,
  onPlay,
}: {
  scan: ScanRow;
  busy: "generate" | "regenerate" | null;
  onGenerate: () => void;
  onRegenerate: () => void;
  onPlay: () => void;
}) {
  const clip = scan.clip;
  const clipReady = clip?.status === "ready";
  const clipFailed = clip?.status === "failed";

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={clipReady ? onPlay : undefined}
        disabled={!clipReady}
        className={`relative w-full aspect-video bg-slate-900 group ${
          clipReady ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <div
          className="absolute inset-0 bg-gradient-to-br from-slate-800 to-black"
          style={{
            backgroundImage:
              "radial-gradient(ellipse at 40% 50%, rgba(16,185,129,0.12) 0%, transparent 60%)",
          }}
        />
        {clipReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-10 w-10 rounded-full bg-white/15 backdrop-blur-md group-hover:bg-white/25 flex items-center justify-center transition-colors">
              <Play className="h-4 w-4 text-white translate-x-0.5" />
            </div>
          </div>
        )}
        {scan.camera && (
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm text-white text-[10px] font-mono">
            {scan.camera.camera_code}
          </div>
        )}
        {clipReady && clip?.duration_seconds != null && (
          <div
            className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm text-white text-[10px] font-mono inline-flex items-center gap-1"
            title={clipDurationTooltip(clip)}
          >
            <Clock className="h-3 w-3" /> {formatDuration(clip.duration_seconds)}
          </div>
        )}
      </button>
      <div className="p-2.5 space-y-1.5">
        <p className="font-mono text-xs font-semibold text-slate-800 truncate">
          {scan.waybill_code}
        </p>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>{new Date(scan.scanned_at).toLocaleString("vi-VN")}</span>
          {clipReady && (
            <span className="font-mono">{formatBytes(clip!.clip_size_bytes)}</span>
          )}
        </div>
        <div className="text-[10px] text-slate-500 truncate">
          {scan.warehouse?.name ?? "—"}
          {scan.station ? ` · ${scan.station.code}` : ""}
        </div>
        {scan.staff && (
          <div className="text-[10px] text-slate-500 truncate inline-flex items-center gap-1">
            <User className="h-3 w-3 text-slate-400" />
            {scan.staff.full_name}
          </div>
        )}
        {clipFailed && clip?.error_message && (
          <div
            className="text-[10px] text-rose-700 truncate"
            title={clip.error_message}
          >
            {clip.error_message.split("\n")[0]}
          </div>
        )}
        <div className="flex items-center gap-1 pt-1">
          {clipReady ? (
            <>
              <button
                onClick={onPlay}
                className="flex-1 h-7 rounded-md bg-violet-50 hover:bg-violet-100 text-violet-700 inline-flex items-center justify-center gap-1 text-[11px] font-semibold"
              >
                <Play className="h-3 w-3" /> Xem
              </button>
              <button
                onClick={onRegenerate}
                disabled={busy !== null}
                className="h-7 px-2 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 text-[11px] font-semibold disabled:opacity-60"
                title="Tạo lại"
              >
                {busy === "regenerate" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCw className="h-3 w-3" />
                )}
              </button>
            </>
          ) : (
            <button
              onClick={onGenerate}
              disabled={busy !== null}
              className="flex-1 h-7 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center justify-center gap-1 text-[11px] font-semibold disabled:opacity-60"
            >
              {busy === "generate" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {clipFailed ? "Thử lại" : "Tạo clip"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerModal({
  scan,
  onClose,
}: {
  scan: ScanRow;
  onClose: () => void;
}) {
  const clip = scan.clip!;
  const scannedAt = new Date(scan.scanned_at);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-4xl relative overflow-hidden max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-2 right-2 z-10 h-8 w-8 rounded-lg bg-black/60 hover:bg-black text-white inline-flex items-center justify-center"
        >
          <X className="h-4 w-4" />
        </button>
        <video
          src={`/api/order-proof/clips/${clip.id}`}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="w-full aspect-video bg-black"
        />
        {clip.transcoded_for_browser && (
          <div className="px-4 pt-2 text-[11px] text-slate-500">
            Đã chuyển mã sang H.264 để xem được trên trình duyệt.
          </div>
        )}
        <div className="p-4 lg:p-5 overflow-y-auto">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="font-mono text-base font-semibold text-slate-900">
                {scan.waybill_code}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {scannedAt.toLocaleString("vi-VN")}
              </p>
            </div>
            <div
              className="inline-flex items-center gap-1.5 text-[11px] text-slate-600"
              title={clipDurationTooltip(clip)}
            >
              <Clock className="h-3.5 w-3.5 text-slate-400" />
              <span>{formatDuration(clip.duration_seconds)}</span>
              <span className="text-slate-300">·</span>
              <HardDrive className="h-3.5 w-3.5 text-slate-400" />
              <span className="font-mono">
                {formatBytes(clip.clip_size_bytes)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <DetailField
              icon={WarehouseIcon}
              label="Kho"
              value={scan.warehouse?.name ?? "—"}
            />
            <DetailField
              icon={Package}
              label="Bàn"
              value={
                scan.station
                  ? `${scan.station.code} · ${scan.station.name}`
                  : "—"
              }
            />
            <DetailField
              icon={User}
              label="Nhân viên"
              value={
                scan.staff
                  ? `${scan.staff.staff_code} · ${scan.staff.full_name}`
                  : "Không có ca"
              }
            />
            <DetailField
              icon={Camera}
              label="Camera"
              value={
                scan.camera
                  ? `${scan.camera.camera_code}${
                      scan.camera.name ? ` · ${scan.camera.name}` : ""
                    }`
                  : "—"
              }
            />
            <DetailField
              icon={Timer}
              label="T/g đóng đơn"
              value={formatDuration(scan.work_duration_seconds)}
            />
            {clip?.cut_ended_at && (
              <DetailField
                icon={Clock}
                label="Video bắt đầu"
                value={formatClockTime(
                  videoStartFromEnd(clip.cut_ended_at, clip.duration_seconds),
                )}
              />
            )}
            {clip?.cut_ended_at && (
              <DetailField
                icon={Clock}
                label="Video kết thúc"
                value={formatClockTime(clip.cut_ended_at)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailField({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="inline-flex items-center gap-1 text-[11px] text-slate-500">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
        {label}
      </div>
      <p className="text-xs text-slate-800 mt-0.5 font-medium truncate">
        {value}
      </p>
    </div>
  );
}
