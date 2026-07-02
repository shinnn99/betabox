"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Circle,
  Clock,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  Package,
  Play,
  Plus,
  RefreshCcw,
  RotateCw,
  Search,
  Timer,
  User,
  Video,
  Warehouse as WarehouseIcon,
  WifiOff,
  X,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import DateRangePicker from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";

/**
 * Lát 3d list migration: `/dashboard/videos` từng chạy stack cũ (backend
 * Vercel spawn ffmpeg + đọc clip_path local). Migration đưa list vào
 * luồng agent-pattern:
 *   - Nút [Tạo clip]/[Thử lại]/[Tạo lại] → link sang /dashboard/orders/{peId}/watch
 *     (trang detail có state machine 3c/3d — auto POST /watch enqueue cut).
 *   - Nút [Xem] mở modal, modal gọi POST /watch trực tiếp và render theo
 *     state THẬT trả về — KHÔNG hardcode "mở từ [Xem] nên ready".
 *   - Cột "Clip" tách bucket-valid vs status='ready': ready-cloud vs
 *     ready-chưa-cloud. Row cũ clip_path=local + bucket=null hiện
 *     [Tạo lại] không phải [Xem] (proactive, không đợi <video> lỗi).
 *   - Badge "Kho offline" khi agent_offline_seconds > 30 (nguồn chung
 *     readAgentLiveness với /watch — cùng HÀM, không chỉ cùng cột).
 *
 * KHÔNG đẻ luồng thứ hai. List không tự enqueue, không poll — mọi hành
 * động đi qua /watch (trang detail hoặc modal gọi 1 lần). Cùng bài học
 * task_id/sweep: một cửa, không hai chỗ cùng làm một việc.
 */

const AGENT_OFFLINE_THRESHOLD_SECONDS = 30;

interface ClipSummary {
  id: string;
  status: "pending" | "ready" | "failed";
  duration_seconds: number | null;
  target_duration_seconds: number | null;
  cut_duration_seconds: number | null;
  target_started_at: string | null;
  target_ended_at: string | null;
  cut_started_at: string | null;
  cut_ended_at: string | null;
  clip_size_bytes: number | null;
  error_message: string | null;
  generated_at: string | null;
  transcoded_for_browser: boolean;
  // 3d migration: tách "clip đã cắt" (status=ready) khỏi "clip xem-ngay-
  // được" (bucket còn TTL). Nếu bucket_uploaded_at null hoặc quá hạn
  // → hiện nút [Tạo lại], không [Xem].
  bucket_path: string | null;
  bucket_uploaded_at: string | null;
}

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
  clip: ClipSummary | null;
  agent_offline_seconds: number;
}

const BUCKET_TTL_HOURS = 72;

// clipBucketValid — cùng công thức với `clipBucketValid` ở service.ts
// (bài học nguồn-sự-thật-duy-nhất, nhưng đây là client, không import
// server-only được). Nếu đổi TTL, đổi CẢ hai chỗ.
function clipBucketValid(clip: ClipSummary | null): boolean {
  if (!clip) return false;
  if (clip.status !== "ready") return false;
  if (!clip.bucket_path || !clip.bucket_uploaded_at) return false;
  const uploadedMs = new Date(clip.bucket_uploaded_at).getTime();
  if (!Number.isFinite(uploadedMs)) return false;
  const ageMs = Date.now() - uploadedMs;
  return ageMs < BUCKET_TTL_HOURS * 3600 * 1000;
}

function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("vi-VN", { hour12: false });
}

function videoStartFromEnd(
  endIso: string | null,
  durationSeconds: number | null,
): string | null {
  if (!endIso || durationSeconds == null) return null;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return null;
  return new Date(end.getTime() - durationSeconds * 1000).toISOString();
}

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

function formatOfflineDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

type ViewMode = "list" | "grid";

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

// Trạng thái clip render theo 5 nhánh — tách bucket-valid khỏi
// status='ready' để không hứa "Sẵn sàng" cho clip chưa xem-ngay-được.
type ClipCellState =
  | "none"           // Không có row clip → nút [Tạo clip]
  | "processing"     // status='pending' → text "Đang xử lý", nút disabled + link
  | "failed"         // status='failed' → text lỗi + nút [Thử lại]
  | "ready_cloud"    // status='ready' + bucket còn TTL → nút [Xem] + [Tạo lại]
  | "ready_no_cloud"; // status='ready' + bucket null/expired → nút [Tạo lại]

function clipCellState(clip: ClipSummary | null): ClipCellState {
  if (!clip) return "none";
  if (clip.status === "pending") return "processing";
  if (clip.status === "failed") return "failed";
  if (clipBucketValid(clip)) return "ready_cloud";
  return "ready_no_cloud";
}

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
              onPlay={setPlaying}
            />
          ) : (
            <GridView
              loading={loading}
              rows={rows}
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

      {playing && (
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
  onPlay,
}: {
  loading: boolean;
  rows: ScanRow[];
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
  onPlay,
}: {
  loading: boolean;
  rows: ScanRow[];
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
          onPlay={() => onPlay(r)}
        />
      ))}
    </div>
  );
}

/**
 * URL sang trang detail /watch cho một scan. Mọi hành động cắt/upload
 * trong luồng 3c/3d đi qua đây — list KHÔNG tự enqueue.
 */
function watchPageHref(peId: string): string {
  return `/dashboard/orders/${peId}/watch`;
}

// Badge "Kho offline" hiển thị khi agent_offline_seconds vượt ngưỡng.
// Không đọc trực tiếp: gọi qua component để giữ style thống nhất.
function OfflineBadge({ seconds }: { seconds: number }) {
  if (seconds <= AGENT_OFFLINE_THRESHOLD_SECONDS) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700"
      title={`Agent kho không phản hồi ${formatOfflineDuration(seconds)}. Bấm nút để mở trang xem chi tiết trạng thái.`}
    >
      <WifiOff className="h-3 w-3" />
      Kho offline
    </span>
  );
}

// Render badge + text mô tả cho một trạng thái clip. Không nút — nút do
// caller quyết theo layout (list/grid).
function ClipStateCell({ scan }: { scan: ScanRow }) {
  const clip = scan.clip;
  const state = clipCellState(clip);

  if (state === "none") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
        <Circle className="h-3 w-3" /> Chưa có
      </span>
    );
  }
  if (state === "processing") {
    return (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700">
        Đang xử lý
      </span>
    );
  }
  if (state === "failed") {
    return (
      <>
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-rose-50 text-rose-700">
          Lỗi
        </span>
        {clip?.error_message && (
          <div
            className="text-[10px] text-rose-700 mt-0.5 max-w-[180px] truncate"
            title={clip.error_message}
          >
            {clip.error_message.split("\n")[0]}
          </div>
        )}
      </>
    );
  }
  if (state === "ready_cloud") {
    return (
      <>
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">
          Sẵn sàng
        </span>
        <div
          className="text-[10px] text-slate-500 mt-0.5"
          title={clipDurationTooltip(clip!)}
        >
          {formatDuration(clip!.duration_seconds)} ·{" "}
          {formatBytes(clip!.clip_size_bytes)}
        </div>
      </>
    );
  }
  // ready_no_cloud
  return (
    <>
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-700 inline-flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" />
        Chưa lên cloud
      </span>
      <div className="text-[10px] text-slate-500 mt-0.5">
        Clip cũ chỉ có trên ổ kho. Bấm Tạo lại để cắt+upload.
      </div>
    </>
  );
}

// Nút hành động theo state clip + agent offline.
// Mọi nút hành-động = <a target="_blank"> sang /watch. KHÔNG handler async
// trong list — mọi hành động đi qua trang detail (một cửa).
function ScanActions({ scan, onPlay }: { scan: ScanRow; onPlay: () => void }) {
  const state = clipCellState(scan.clip);
  const watchUrl = watchPageHref(scan.id);

  if (state === "ready_cloud") {
    return (
      <div className="inline-flex items-center justify-end gap-1">
        <button
          onClick={onPlay}
          className="h-8 px-2.5 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 inline-flex items-center gap-1 text-xs font-semibold"
        >
          <Play className="h-3 w-3" /> Xem
        </button>
        <a
          href={watchUrl}
          target="_blank"
          rel="noopener"
          className="h-8 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 text-xs font-semibold"
          title="Cắt lại clip (mở trang xem)"
        >
          <RotateCw className="h-3 w-3" />
          Tạo lại
        </a>
      </div>
    );
  }

  if (state === "processing") {
    return (
      <a
        href={watchUrl}
        target="_blank"
        rel="noopener"
        className="h-8 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 text-xs font-semibold"
        title="Đang cắt, mở trang xem để theo dõi tiến độ"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Đang cắt
      </a>
    );
  }

  // none / failed / ready_no_cloud → 1 nút primary sang /watch.
  const label =
    state === "none"
      ? "Tạo clip"
      : state === "failed"
        ? "Thử lại"
        : "Tạo lại";
  const Icon =
    state === "failed" ? RotateCw : state === "ready_no_cloud" ? RotateCw : Plus;

  return (
    <a
      href={watchUrl}
      target="_blank"
      rel="noopener"
      className="h-8 px-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 text-xs font-semibold"
    >
      <Icon className="h-3 w-3" />
      {label}
    </a>
  );
}

function ScanRowView({
  scan,
  onPlay,
}: {
  scan: ScanRow;
  onPlay: () => void;
}) {
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
        <ClipStateCell scan={scan} />
      </td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        <div className="inline-flex flex-col items-end gap-1">
          <ScanActions scan={scan} onPlay={onPlay} />
          <OfflineBadge seconds={scan.agent_offline_seconds} />
        </div>
      </td>
    </tr>
  );
}

function ScanCardView({
  scan,
  onPlay,
}: {
  scan: ScanRow;
  onPlay: () => void;
}) {
  const clip = scan.clip;
  const state = clipCellState(clip);
  const canPlay = state === "ready_cloud";

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={canPlay ? onPlay : undefined}
        disabled={!canPlay}
        className={`relative w-full aspect-video bg-slate-900 group ${
          canPlay ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <div
          className="absolute inset-0 bg-gradient-to-br from-slate-800 to-black"
          style={{
            backgroundImage:
              "radial-gradient(ellipse at 40% 50%, rgba(16,185,129,0.12) 0%, transparent 60%)",
          }}
        />
        {canPlay && (
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
        {canPlay && clip?.duration_seconds != null && (
          <div
            className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm text-white text-[10px] font-mono inline-flex items-center gap-1"
            title={clipDurationTooltip(clip)}
          >
            <Clock className="h-3 w-3" /> {formatDuration(clip.duration_seconds)}
          </div>
        )}
      </button>
      <div className="p-2.5 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-xs font-semibold text-slate-800 truncate">
            {scan.waybill_code}
          </p>
          <OfflineBadge seconds={scan.agent_offline_seconds} />
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>{new Date(scan.scanned_at).toLocaleString("vi-VN")}</span>
          {canPlay && (
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
        <div className="pt-1">
          <ScanActions scan={scan} onPlay={onPlay} />
        </div>
      </div>
    </div>
  );
}

/**
 * PlayerModal: mount → POST /watch một lần → render theo state THẬT.
 * KHÔNG hardcode "mở từ nút Xem nên chắc ready". Data list có thể cũ
 * (bucket vừa hết TTL giữa lúc load và bấm → race → preparing_upload),
 * modal phải xử được ca này bằng cách đọc state thật, không giả định.
 *
 * `<video>` CHỈ render trong nhánh `ready`. Các nhánh khác hiện text +
 * nút đóng modal điều hướng cùng tab sang trang watch (giữ nhất quán
 * "một cửa" — không đẻ luồng poll trong modal, trang watch là chỗ duy
 * nhất poll).
 */
type WatchState =
  | "preparing_cut"
  | "preparing_upload"
  | "ready"
  | "failed"
  | "upload_failed"
  | "warehouse_offline"
  | "offline_giveup"
  | "unknown";

interface WatchApiResponse {
  state: WatchState;
  signed_url?: string;
  expires_at?: string;
  error?: string;
  offline_duration_seconds?: number;
}

type ModalUiState =
  | { kind: "loading" }
  | { kind: "network_error"; message: string }
  | { kind: "watch_response"; data: WatchApiResponse };

function PlayerModal({
  scan,
  onClose,
}: {
  scan: ScanRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const scannedAt = new Date(scan.scanned_at);
  const watchPageUrl = watchPageHref(scan.id);

  const [ui, setUi] = useState<ModalUiState>({ kind: "loading" });
  // Chỉ chạy fetch 1 lần khi mount. Modal đóng+mở lại = component mới =
  // fetch mới. Không dùng SWR/cache — mỗi lần bấm [Xem] là 1 tick /watch,
  // đảm bảo state luôn tươi (bắt ca race TTL bucket vừa hết hạn).
  const fetchOnce = useRef(false);

  const goToWatch = useCallback(() => {
    onClose();
    router.push(watchPageUrl);
  }, [onClose, router, watchPageUrl]);

  useEffect(() => {
    if (fetchOnce.current) return;
    fetchOnce.current = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/order-proof/${scan.id}/watch`,
          { method: "POST", cache: "no-store" },
        );
        const data = (await res.json()) as WatchApiResponse;
        if (!res.ok && res.status !== 200) {
          // /watch trả 200 cho hầu hết state (kể cả failed/upload_failed).
          // 4xx/5xx = lỗi bất thường (auth, không tìm thấy pe, ...).
          setUi({
            kind: "network_error",
            message: data.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        setUi({ kind: "watch_response", data });
      } catch (err) {
        setUi({
          kind: "network_error",
          message: (err as Error).message,
        });
      }
    })();
  }, [scan.id]);

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

        <ModalBody ui={ui} onGoWatch={goToWatch} />

        {scan.clip?.transcoded_for_browser && (
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
            {scan.clip && (
              <div
                className="inline-flex items-center gap-1.5 text-[11px] text-slate-600"
                title={clipDurationTooltip(scan.clip)}
              >
                <Clock className="h-3.5 w-3.5 text-slate-400" />
                <span>{formatDuration(scan.clip.duration_seconds)}</span>
                <span className="text-slate-300">·</span>
                <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                <span className="font-mono">
                  {formatBytes(scan.clip.clip_size_bytes)}
                </span>
              </div>
            )}
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
            {scan.clip?.cut_ended_at && (
              <DetailField
                icon={Clock}
                label="Video bắt đầu"
                value={formatClockTime(
                  videoStartFromEnd(
                    scan.clip.cut_ended_at,
                    scan.clip.duration_seconds,
                  ),
                )}
              />
            )}
            {scan.clip?.cut_ended_at && (
              <DetailField
                icon={Clock}
                label="Video kết thúc"
                value={formatClockTime(scan.clip.cut_ended_at)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Body của modal — chia theo state /watch response. `<video>` CHỈ render
 * ở nhánh ready. Các nhánh khác hiện text + nút điều hướng cùng tab sang
 * trang watch (goToWatch: onClose() + router.push()).
 *
 * Nguyên tắc: KHÔNG hardcode "mở từ [Xem] nên chắc ready" — luôn đọc
 * state THẬT từ response. Bắt ca race TTL bucket vừa hết hạn.
 */
function ModalBody({
  ui,
  onGoWatch,
}: {
  ui: ModalUiState;
  onGoWatch: () => void;
}) {
  if (ui.kind === "loading") {
    return (
      <div className="w-full aspect-video bg-slate-900 flex items-center justify-center">
        <div className="text-white text-sm inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Đang tải trạng thái...
        </div>
      </div>
    );
  }

  if (ui.kind === "network_error") {
    return (
      <MessageBox
        title="Lỗi tải trạng thái"
        message={ui.message}
        actionLabel="Mở trang xem clip"
        onAction={onGoWatch}
      />
    );
  }

  const { data } = ui;

  if (data.state === "ready" && data.signed_url) {
    return (
      <video
        src={data.signed_url}
        controls
        autoPlay
        playsInline
        preload="metadata"
        className="w-full aspect-video bg-black"
      />
    );
  }

  if (data.state === "preparing_cut") {
    return (
      <MessageBox
        title="Clip đang được cắt"
        message="Agent kho đang cắt clip từ segment gốc. Thường mất 10–30s. Mở trang xem để theo dõi tiến độ."
        actionLabel="Mở trang xem"
        onAction={onGoWatch}
      />
    );
  }

  if (data.state === "preparing_upload") {
    return (
      <MessageBox
        title="Clip đang được đồng bộ lên cloud"
        message="Clip đã cắt, agent đang upload lên bucket. Thường mất vài giây. Mở trang xem để theo dõi."
        actionLabel="Mở trang xem"
        onAction={onGoWatch}
      />
    );
  }

  if (data.state === "warehouse_offline") {
    const dur = data.offline_duration_seconds ?? 0;
    return (
      <MessageBox
        title="Kho đang offline"
        message={`Agent kho không phản hồi ${formatOfflineDuration(dur)}. Chờ agent về mạng rồi thử lại. Mở trang xem để theo dõi tự động.`}
        actionLabel="Mở trang xem"
        onAction={onGoWatch}
        icon={WifiOff}
      />
    );
  }

  if (data.state === "offline_giveup") {
    const dur = data.offline_duration_seconds ?? 0;
    return (
      <MessageBox
        title="Kho offline quá lâu"
        message={`Agent kho đã offline ${formatOfflineDuration(dur)}. Kiểm tra agent trên máy kho, rồi thử lại. Mở trang xem để retry thủ công.`}
        actionLabel="Mở trang xem"
        onAction={onGoWatch}
        icon={WifiOff}
      />
    );
  }

  if (data.state === "failed") {
    return (
      <MessageBox
        title="Cắt clip thất bại"
        message={data.error ?? "Không rõ lý do. Mở trang xem để thử lại."}
        actionLabel="Mở trang xem"
        onAction={onGoWatch}
        icon={AlertTriangle}
      />
    );
  }

  if (data.state === "upload_failed") {
    return (
      <MessageBox
        title="Upload lên cloud thất bại"
        message={data.error ?? "Agent không upload được clip lên cloud. Mở trang xem để thử lại."}
        actionLabel="Mở trang xem"
        onAction={onGoWatch}
        icon={AlertTriangle}
      />
    );
  }

  // 'unknown' hoặc ready-nhưng-thiếu-signed_url (không kỳ vọng) — fallback
  // an toàn: điều hướng sang trang watch. KHÔNG render <video> khi thiếu
  // signed_url (ca âm ca 7).
  return (
    <MessageBox
      title="Trạng thái chưa xác định"
      message="Mở trang xem để lấy trạng thái mới nhất."
      actionLabel="Mở trang xem"
      onAction={onGoWatch}
    />
  );
}

function MessageBox({
  title,
  message,
  actionLabel,
  onAction,
  icon: Icon,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
  icon?: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="w-full aspect-video bg-slate-900 flex flex-col items-center justify-center gap-3 p-6 text-center">
      {Icon && <Icon className="h-8 w-8 text-slate-300" />}
      <div className="text-white text-sm font-medium">{title}</div>
      <div className="text-slate-300 text-xs max-w-md">{message}</div>
      <button
        onClick={onAction}
        className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold"
      >
        {actionLabel}
      </button>
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
