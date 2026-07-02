"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  useWatchClipState,
  formatOfflineDuration,
  type WatchClipState,
} from "@/lib/watch/use-watch-clip-state";

/**
 * Lát 3d list migration + UX một-cửa-thật-sự (2026-07-03):
 *
 * `/dashboard/videos` từng chạy stack cũ (backend Vercel spawn ffmpeg +
 * đọc clip_path local). Migration đưa list vào luồng agent-pattern, và
 * gom mọi thao tác vào modal — không nhảy tab, không link sang trang
 * khác. Trang `/dashboard/orders/[pe_id]/watch` cũ đã xóa; state machine
 * 3c/3d chuyển vào hook `useWatchClipState` dùng chung.
 *
 * Mọi nút hành động (Xem/Tạo clip/Thử lại/Tạo lại) mở CÙNG một modal,
 * khác nhau chỉ ở state ban đầu — user không cần nhớ nút nào mở gì.
 * Modal tự POST /watch, tự poll (2s active / 20s offline), tự xử 8
 * nhánh state, cleanup timer khi đóng.
 *
 * KHÔNG đẻ luồng thứ hai. Modal là NƠI POLL DUY NHẤT (trang detail đã
 * xóa). Nguyên tắc "một nơi poll" giữ nguyên, chỉ đổi vị trí từ trang
 * sang modal.
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

// formatOfflineDuration import từ @/lib/watch/use-watch-clip-state — dùng
// chung với modal, đừng chép công thức ra hai chỗ.

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
  // Modal state: null = đóng. Khi mở, mang cả scan + mode để modal biết
  // phải render "view" (ready ngay) / "generate" (retry + poll) / "watch"
  // (poll tiếp).
  const [openModal, setOpenModal] = useState<{
    scan: ScanRow;
    mode: ModalMode;
  } | null>(null);
  const openFor = useCallback(
    (scan: ScanRow) => (mode: ModalMode) => setOpenModal({ scan, mode }),
    [],
  );

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
              openFor={openFor}
            />
          ) : (
            <GridView
              loading={loading}
              rows={rows}
              openFor={openFor}
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

      {openModal && (
        <PlayerModal
          scan={openModal.scan}
          mode={openModal.mode}
          onClose={() => setOpenModal(null)}
        />
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
  openFor,
}: {
  loading: boolean;
  rows: ScanRow[];
  openFor: (r: ScanRow) => (mode: ModalMode) => void;
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
                onOpen={openFor(r)}
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
  openFor,
}: {
  loading: boolean;
  rows: ScanRow[];
  openFor: (r: ScanRow) => (mode: ModalMode) => void;
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
          onOpen={openFor(r)}
        />
      ))}
    </div>
  );
}

// Badge "Kho offline" hiển thị khi agent_offline_seconds vượt ngưỡng.
// Không đọc trực tiếp: gọi qua component để giữ style thống nhất.
function OfflineBadge({ seconds }: { seconds: number }) {
  if (seconds <= AGENT_OFFLINE_THRESHOLD_SECONDS) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700"
      title={`Agent kho không phản hồi ${formatOfflineDuration(seconds)}. Bấm nút để mở modal xem chi tiết trạng thái.`}
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

/**
 * Nút hành động — MỌI nút mở CÙNG modal, khác nhau chỉ ở state ban đầu.
 * Modal tự POST /watch (auto enqueue cut nếu chưa có clip), tự poll đến
 * ready/terminal. User không nhảy tab, không link — một cửa trong list.
 *
 * `mode` truyền vào modal:
 *   - "view"   : row ready_cloud → mở modal, /watch trả ready ngay → video.
 *   - "generate": row none/failed/ready_no_cloud → mở modal, /watch enqueue
 *                 cut → poll preparing → ready.
 *   - "watch"  : row processing (đang cắt ở tab khác) → mở modal → poll
 *                 tiếp cho đến ready.
 * "generate" cần POST /watch/retry TRƯỚC khi tick đầu (xóa row failed +
 * bucket cũ, không thì reconcile thấy failed → loop). "view"/"watch" chỉ
 * cần tick /watch bình thường.
 */
type ModalMode = "view" | "generate" | "watch";

function ScanActions({
  scan,
  onOpen,
}: {
  scan: ScanRow;
  onOpen: (mode: ModalMode) => void;
}) {
  const state = clipCellState(scan.clip);

  if (state === "ready_cloud") {
    return (
      <div className="inline-flex items-center justify-end gap-1">
        <button
          onClick={() => onOpen("view")}
          className="h-8 px-2.5 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 inline-flex items-center gap-1 text-xs font-semibold"
        >
          <Play className="h-3 w-3" /> Xem
        </button>
        <button
          onClick={() => onOpen("generate")}
          className="h-8 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 text-xs font-semibold"
          title="Cắt lại clip từ đầu"
        >
          <RotateCw className="h-3 w-3" />
          Tạo lại
        </button>
      </div>
    );
  }

  if (state === "processing") {
    return (
      <button
        onClick={() => onOpen("watch")}
        className="h-8 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 text-xs font-semibold"
        title="Đang cắt, mở modal để theo dõi tiến độ"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Đang cắt
      </button>
    );
  }

  // none / failed / ready_no_cloud → 1 nút primary mở modal generate.
  const label =
    state === "none"
      ? "Tạo clip"
      : state === "failed"
        ? "Thử lại"
        : "Tạo lại";
  const Icon =
    state === "failed" ? RotateCw : state === "ready_no_cloud" ? RotateCw : Plus;

  return (
    <button
      onClick={() => onOpen("generate")}
      className="h-8 px-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 text-xs font-semibold"
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

function ScanRowView({
  scan,
  onOpen,
}: {
  scan: ScanRow;
  onOpen: (mode: ModalMode) => void;
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
          <ScanActions scan={scan} onOpen={onOpen} />
          <OfflineBadge seconds={scan.agent_offline_seconds} />
        </div>
      </td>
    </tr>
  );
}

function ScanCardView({
  scan,
  onOpen,
}: {
  scan: ScanRow;
  onOpen: (mode: ModalMode) => void;
}) {
  const clip = scan.clip;
  const state = clipCellState(clip);
  const canPlay = state === "ready_cloud";

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={canPlay ? () => onOpen("view") : undefined}
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
          <ScanActions scan={scan} onOpen={onOpen} />
        </div>
      </div>
    </div>
  );
}

/**
 * PlayerModal: dùng hook `useWatchClipState` — mount → gọi start()/retry()
 * theo mode → tự POST /watch, tự poll 2s active / 20s offline, tự cleanup
 * khi đóng. Modal là NƠI POLL DUY NHẤT (trang /watch đã xóa).
 *
 * KHÔNG hardcode "mở từ nút Xem nên chắc ready". Data list có thể cũ
 * (bucket vừa hết TTL giữa lúc load và bấm → race → preparing_upload),
 * modal phải xử được ca này bằng cách đọc state thật, không giả định.
 *
 * `<video>` CHỈ render trong nhánh `ready` + có signed_url. Các nhánh
 * khác hiện text + nút retry inline (không link đi đâu).
 *
 * mode:
 *   - "view"   : chỉ start(), /watch trả ready ngay → video.
 *   - "generate": retry() trước (xóa row+bucket cũ) rồi start() ẩn dưới,
 *                 tick đầu enqueue cut → poll preparing → ready.
 *   - "watch"  : start(), /watch cho biết đang preparing → poll tiếp.
 */
function PlayerModal({
  scan,
  mode,
  onClose,
}: {
  scan: ScanRow;
  mode: ModalMode;
  onClose: () => void;
}) {
  const scannedAt = new Date(scan.scanned_at);
  const watch = useWatchClipState(scan.id);

  // Kick tick đầu theo mode. Chạy 1 lần khi mount — hook idempotent nếu
  // gọi start() 2 lần liên tiếp.
  useEffect(() => {
    if (mode === "generate") {
      void watch.retry();
    } else {
      watch.start();
    }
    // Chỉ chạy khi mount. Đổi mode giữa chừng không xảy ra (modal đóng
    // rồi mở lại = component mới).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup: khi user đóng modal → stop poll. Hook đã có cleanup unmount,
  // đây là gọi tường minh để đảm bảo không có race giữa unmount và tick
  // đang pending.
  const handleClose = useCallback(() => {
    watch.stop();
    onClose();
  }, [watch, onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-4xl relative overflow-hidden max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          className="absolute top-2 right-2 z-10 h-8 w-8 rounded-lg bg-black/60 hover:bg-black text-white inline-flex items-center justify-center"
        >
          <X className="h-4 w-4" />
        </button>

        <ModalBody watch={watch} />

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
 * Body của modal — chia theo state hook trả về. `<video>` CHỈ render ở
 * nhánh ready + có signed_url. Các nhánh khác hiện text + nút retry
 * inline (không link đi đâu — modal tự retry qua hook).
 *
 * Nguyên tắc: KHÔNG hardcode "mở từ [Xem] nên chắc ready" — luôn đọc
 * state THẬT từ hook. Bắt ca race TTL bucket vừa hết hạn (mở [Xem] →
 * hook tick /watch → server thấy bucket hết hạn → trả preparing_upload
 * → modal poll tiếp đến ready thật, không video-đen).
 */
function ModalBody({ watch }: { watch: ReturnType<typeof useWatchClipState> }) {
  // idle = hook chưa tick lần đầu (start()/retry() vừa gọi). Hiển thị
  // "đang tải trạng thái" ngắn. Sau tick đầu, state chuyển sang một
  // trong 8 nhánh cụ thể.
  if (watch.state === "idle") {
    return (
      <div className="w-full aspect-video bg-slate-900 flex items-center justify-center">
        <div className="text-white text-sm inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Đang tải trạng thái...
        </div>
      </div>
    );
  }

  if (watch.state === "network_error") {
    return (
      <MessageBox
        title="Lỗi tải trạng thái"
        message={watch.errorMessage ?? "Không rõ lý do"}
        actionLabel="Thử lại"
        onAction={watch.retry}
      />
    );
  }

  if (watch.state === "ready" && watch.signedUrl) {
    return (
      <video
        src={watch.signedUrl}
        controls
        autoPlay
        playsInline
        preload="metadata"
        className="w-full aspect-video bg-black"
      />
    );
  }

  if (watch.state === "preparing_cut") {
    return (
      <ProgressBox
        title="Đang tải clip, vui lòng đợi..."
        message="Agent kho đang cắt clip từ segment gốc. Thường mất 10–30s."
        elapsedSeconds={watch.elapsedSeconds}
      />
    );
  }

  if (watch.state === "preparing_upload") {
    return (
      <ProgressBox
        title="Đang tải clip, vui lòng đợi..."
        message="Clip đã cắt, agent đang đồng bộ lên cloud. Thường mất vài giây."
        elapsedSeconds={watch.elapsedSeconds}
      />
    );
  }

  if (watch.state === "warehouse_offline") {
    const dur = watch.offlineDurationSeconds ?? 0;
    return (
      <MessageBox
        title="Kho đang offline"
        message={`Agent kho không phản hồi ${formatOfflineDuration(dur)}. Đang tự động chờ agent về mạng và thử lại — không cần đóng cửa sổ này.`}
        icon={WifiOff}
      />
    );
  }

  if (watch.state === "offline_giveup") {
    const dur = watch.offlineDurationSeconds ?? 0;
    return (
      <MessageBox
        title="Kho offline quá lâu"
        message={`Agent kho đã offline ${formatOfflineDuration(dur)}. Kiểm tra agent trên máy kho, rồi thử lại.`}
        actionLabel="Thử lại"
        onAction={watch.retry}
        icon={WifiOff}
      />
    );
  }

  if (watch.state === "failed") {
    return (
      <MessageBox
        title="Cắt clip thất bại"
        message={watch.errorMessage ?? "Không rõ lý do."}
        actionLabel="Thử lại"
        onAction={watch.retry}
        icon={AlertTriangle}
      />
    );
  }

  if (watch.state === "upload_failed") {
    return (
      <MessageBox
        title="Đồng bộ cloud thất bại"
        message={watch.errorMessage ?? "Agent không tải được clip lên cloud."}
        actionLabel="Thử lại"
        onAction={watch.retry}
        icon={AlertTriangle}
      />
    );
  }

  // Fallback an toàn — không kỳ vọng rơi vào đây (mọi state đã handle).
  // KHÔNG render <video> khi state không phải ready (ca âm chặn video-đen).
  return (
    <MessageBox
      title="Trạng thái chưa xác định"
      message="Đóng cửa sổ và mở lại, hoặc bấm Thử lại."
      actionLabel="Thử lại"
      onAction={watch.retry}
    />
  );
}

/**
 * Hộp hiển thị lúc đang chờ (preparing_cut / preparing_upload). Có
 * elapsed counter + spinner để user thấy hệ đang chạy, không đứng yên.
 */
function ProgressBox({
  title,
  message,
  elapsedSeconds,
}: {
  title: string;
  message: string;
  elapsedSeconds: number;
}) {
  return (
    <div className="w-full aspect-video bg-slate-900 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <Loader2 className="h-8 w-8 text-emerald-400 animate-spin" />
      <div className="text-white text-sm font-medium">{title}</div>
      <div className="text-slate-300 text-xs max-w-md">{message}</div>
      <div className="text-slate-400 text-[11px] font-mono">
        Đã chờ {elapsedSeconds}s
      </div>
    </div>
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
  actionLabel?: string;
  onAction?: () => void;
  icon?: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="w-full aspect-video bg-slate-900 flex flex-col items-center justify-center gap-3 p-6 text-center">
      {Icon && <Icon className="h-8 w-8 text-slate-300" />}
      <div className="text-white text-sm font-medium">{title}</div>
      <div className="text-slate-300 text-xs max-w-md">{message}</div>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold"
        >
          {actionLabel}
        </button>
      )}
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
