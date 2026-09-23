"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  History,
  PackageCheck,
  PackageOpen,
  PackageX,
  Radio,
  ScanLine,
  Timer,
  Users,
  Warehouse as WarehouseIcon,
  WifiOff,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import StatCard from "@/components/StatCard";
import StationLivePanel from "@/components/station/StationLivePanel";
import { useToast } from "@/components/ui/Toast";
import { formatDateKeyVn, shiftDateKey, vnDateKey } from "@/lib/time/vietnam";
import { startVisibilityPolling } from "@/lib/polling/visibility-poller";
import ReturnCapturePanel from "@/components/returns/ReturnCapturePanel";

/**
 * Giám sát hoàn hàng.
 *
 * Chủ dự án chốt (21/09/2026): giao diện giống hệt Giám sát đóng hàng, chỉ
 * khác chức năng — và là trang RIÊNG, không nhét vào trang cũ rồi đổi
 * chức năng bên trong. File này được chép nguyên văn từ
 * src/app/dashboard/operations/page.tsx rồi đổi phần nghiệp vụ; bố cục,
 * màu, khoảng cách giữ y hệt. Sửa giao diện trang kia thì nhớ soi lại
 * trang này.
 *
 * Khác chức năng:
 *   - Dữ liệu từ /api/returns/live/* (kiện hoàn, không phải đơn đi).
 *   - Thẻ số: Đã nhận · Quét lại · Cần xử lý (hồ sơ mở) · Nhân sự.
 *   - Cần xử lý: hồ sơ kiện có vấn đề, mã quay lại bàn đóng hàng.
 *   - Nhật ký: kiện hoàn + thẻ điều khiển.
 *   - Ô Bắt đầu / Kết thúc nhận hoàn (tín hiệu module xuống agent).
 *
 * Kế hoạch: plans/active/HOAN-HANG-giao-dien-giam-sat-bang-chung.md
 */

const POLL_INTERVAL_MS = 3000;
/**
 * Ước lượng dung lượng proof chạy nhịp riêng, chậm hơn nhiều: đơn đã
 * đóng thì con số không đổi, và mỗi lần tính phải query segment.
 */
const PROOF_RISK_POLL_INTERVAL_MS = 60000;
const FLASH_DURATION_MS = 1500;
/** Số dòng nhật ký tải mỗi lần. Bấm "Tải thêm" cộng thêm một bậc. */
const ACTIVITY_PAGE_SIZE = 100;
/** Phải khớp ACTIVITY_MAX_LIMIT ở src/lib/warehouse/live/activity.ts (dùng chung). */
const ACTIVITY_MAX_LIMIT = 500;
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
    /** Kiện hoàn đã nhận hôm nay (không tính lượt quét lại). */
    received: number;
    ok: number;
    /** Kết quả khác OK: hỏng / thiếu / tráo / chưa kiểm. */
    problem: number;
    /** Quét lại kiện đã ghi hoàn. */
    duplicated: number;
    /** Mã đã gửi đi quay lại bàn đóng hàng (lưới an toàn). */
    suspect: number;
    /** Kiện đang mở. */
    open: number;
    /** Hồ sơ chưa khiếu nại — mọi ngày, không chỉ hôm nay. */
    open_claims: number;
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
  /** Số kiện hoàn của bàn hôm nay. */
  packing_count_today: number;
  mode: "outbound" | "return";
  capture_state: "none" | "active" | "draining" | "finished" | "abandoned";
}

interface StationsResponse {
  stations: StationCard[];
}

// Cùng bộ với trang Giám sát đóng hàng — chủ dự án chốt 23/09/2026.
type ActivityKind =
  | "waybill_valid"
  | "waybill_duplicated"
  | "waybill_no_session"
  | "waybill_unmapped"
  | "waybill_invalid"
  | "waybill_return_suspect"
  | "qr_invalid"
  | "control_card";

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
  /** Ngày VN mà server thực sự trả (có thể khác ngày client gửi nếu gửi rác). */
  date: string;
  invalid_date: boolean;
  limit: number;
  /** Tổng sự kiện của ngày đó, kể cả phần chưa tải. */
  total: number;
}

type IssueKind = "claim_open" | "return_suspect" | "duplicated_return";

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

/**
 * Phản hồi của /api/returns/live/overview — bốn khối trong một request.
 *
 * `activity` null khi client xin `include_activity=0` (đang xem ngày quá
 * khứ: nhật ký không đổi nên nhịp poll không kéo lại) HOẶC khi riêng phần
 * nhật ký lỗi — phân biệt hai ca bằng `activity_error`.
 */
interface OverviewResponse {
  summary: SummaryResponse;
  stations: StationsResponse;
  issues: IssuesResponse;
  activity: ActivityResponse | null;
  activity_error: string | null;
}

type ProofSizeRisk = "safe" | "near_limit" | "over_limit" | "unknown";

/**
 * Cảnh báo sớm proof clip vượt trần upload. Poll nhịp RIÊNG, chậm hơn
 * hẳn activity: đơn đã đóng thì kích thước clip không đổi nữa, và ước
 * lượng phải query segment nên không đặt chung nhịp 3 giây được.
 *
 * Ngưỡng đến từ API (`upload_guard_bytes`) — KHÔNG hardcode 49 MiB ở
 * component. Agent, API và UI phải cùng một con số, không phải ba
 * literal độc lập.
 */
interface ProofRisk {
  packing_event_id: string;
  raw_event_id: string | null;
  proof_size_risk: ProofSizeRisk;
  estimated_file_size_bytes: number | null;
  estimated_bitrate_kbps: number | null;
  proof_window_seconds: number;
  upload_guard_bytes: number;
  estimate_method: "overlapping_segments" | "camera_recent_p95" | "none";
  estimate_correction_factor: number;
}

interface ProofRiskResponse {
  risks: ProofRisk[];
  upload_guard_bytes: number;
  warn_bytes: number;
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

// Chép đúng bảng nhãn của trang Giám sát đóng hàng — chủ dự án chốt
// 23/09/2026: cùng một việc thì cùng một chữ.
const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  waybill_valid: "Hợp lệ",
  waybill_duplicated: "Trùng",
  waybill_no_session: "Chưa vào ca",
  waybill_unmapped: "Máy quét chưa gán",
  waybill_invalid: "Mã sai",
  waybill_return_suspect: "Hàng hoàn",
  qr_invalid: "QR sai",
  control_card: "Thẻ",
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
  claim_open: PackageX,
  return_suspect: History,
  duplicated_return: Copy,
};

const ISSUE_KIND_TONE: Record<IssueKind, "warning" | "error"> = {
  claim_open: "error",
  return_suspect: "warning",
  duplicated_return: "warning",
};

function describeActivityToast(ev: ActivityItem): {
  variant: "success" | "error" | "info";
  message: string;
} {
  const where = ev.station_name ? ` · ${ev.station_name}` : "";
  const who = ev.staff_name ? ` · ${ev.staff_name}` : "";
  switch (ev.kind) {
    case "waybill_valid":
      return { variant: "success", message: `Kiện hoàn ${ev.waybill_code}${who}${where}` };
    case "waybill_duplicated":
      return { variant: "info", message: `${ev.waybill_code} đã được quét trước đó` };
    case "waybill_no_session":
      return { variant: "error", message: `${ev.waybill_code} quét khi chưa mở ca${where}` };
    case "waybill_return_suspect":
      // Không phải lỗi: hệ thống đã tự tách khỏi số đơn đóng. Để mức thông tin.
      return {
        variant: "info",
        message: `${ev.waybill_code} đã đóng trước đó — hàng hoàn${where}`,
      };
    case "control_card":
      return { variant: "info", message: `${ev.waybill_code ?? "Thẻ điều khiển"}${where}` };
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
    const suspects = issues.filter((i) => i.kind === "return_suspect").length;
    if (suspects >= 3) {
      alerts.push({
        key: "suspect-burst",
        message: `${suspects} mã đã gửi đi quay lại bàn đóng hàng hôm nay — nhắc nhân viên quét thẻ NHẬN HOÀN trước khi mở kiện hoàn.`,
      });
    }
  }

  return alerts;
}

// ─── Page ──────────────────────────────────────────────────────────────────

type ActivityTab = "all" | "ok" | "duplicated" | "issues" | "staff";

const ACTIVITY_TAB_LABEL: Record<ActivityTab, string> = {
  all: "Tất cả",
  ok: "Hàng ổn",
  duplicated: "Quét lại",
  issues: "Cần xử lý",
  staff: "Thẻ điều khiển",
};

function formatMiB(bytes: number | null): string {
  if (bytes == null) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Cảnh báo sớm proof clip quá nặng.
 *
 * CHỈ hiện cho `over_limit` và `near_limit`. `safe` không cần nói gì,
 * và `unknown` KHÔNG được hiện cảnh báo — không đủ dữ liệu để ước lượng
 * thì im lặng đúng hơn là dựng một cảnh báo mà người đọc không làm gì
 * được với nó.
 *
 * Mọi con số lấy từ API, kể cả ngưỡng. Không viết 49 MiB ở đây.
 */
function ProofSizeBadge({ risk }: { risk?: ProofRisk }) {
  if (!risk) return null;
  if (risk.proof_size_risk !== "over_limit" && risk.proof_size_risk !== "near_limit") {
    return null;
  }

  const size = formatMiB(risk.estimated_file_size_bytes);
  const guard = formatMiB(risk.upload_guard_bytes);
  const methodNote =
    risk.estimate_method === "overlapping_segments"
      ? "Ước tính từ chính các đoạn video của đơn này."
      : risk.estimate_method === "camera_recent_p95"
        ? "Ước tính theo bitrate gần đây của camera (chưa đủ đoạn video phủ khoảng đơn)."
        : "";

  if (risk.proof_size_risk === "over_limit") {
    return (
      <span
        className="mt-0.5 inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
        title={
          `Video đầy đủ của đơn này có khả năng vượt giới hạn tải lên hiện tại ` +
          `(ước tính ${size} / giới hạn ${guard}, clip ~${risk.proof_window_seconds}s). ` +
          `Thời gian đóng gói vẫn giữ nguyên; hệ thống chưa tự rút ngắn video. ` +
          methodNote
        }
      >
        <AlertTriangle className="h-3 w-3" />
        Proof có nguy cơ vượt giới hạn · ~{size}
      </span>
    );
  }

  return (
    <span
      className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-slate-500"
      title={
        `Ước tính ${size}, gần giới hạn tải lên ${guard}. ` +
        `Chưa vượt — chưa cần làm gì. ` +
        methodNote
      }
    >
      Gần giới hạn proof · ~{size}
    </span>
  );
}

function matchActivityTab(
  ev: ActivityItem,
  tab: ActivityTab,
  proofRisk?: ProofRisk,
): boolean {
  if (tab === "all") return true;
  if (tab === "ok") return ev.kind === "waybill_valid";
  if (tab === "duplicated") return ev.kind === "waybill_duplicated";
  if (tab === "issues")
    return (
      ev.kind === "waybill_no_session" ||
      ev.kind === "waybill_invalid" ||
      ev.kind === "waybill_unmapped" ||
      ev.kind === "waybill_return_suspect" ||
      ev.kind === "waybill_duplicated" ||
      // Clip kiện hoàn dài tới 5 phút — vượt trần tải lên thì hồ sơ khiếu
      // nại không có video.
      proofRisk?.proof_size_risk === "over_limit"
    );
  if (tab === "staff") return ev.kind === "control_card";
  return true;
}

export default function ReturnsMonitorPage() {
  const toast = useToast();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [stations, setStations] = useState<StationCard[]>([]);
  const [selectedStationId, setSelectedStationId] = useState("");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<ActivityTab>("all");
  const [dismissedIssueIds, setDismissedIssueIds] = useState<Set<string>>(
    new Set(),
  );

  // Nhật ký hoạt động bó trong MỘT ngày VN, mặc định hôm nay. Đổi ngày chỉ
  // ảnh hưởng bảng này: thẻ KPI, bàn đóng hàng và panel "Cần xử lý" là
  // trạng thái ĐANG DIỄN RA, chọn ngày quá khứ cho chúng thì vô nghĩa
  // (bàn nào "đang có người" hôm qua không phải câu hỏi có nghĩa).
  const [todayKey, setTodayKey] = useState(() => vnDateKey());
  // Cùng một giá trị, không gọi vnDateKey() lần hai: hai lần gọi có thể
  // rơi hai bên nửa đêm và trang mở ra đã ở trạng thái "xem ngày cũ".
  const [dateKey, setDateKey] = useState(todayKey);
  const [activityLimit, setActivityLimit] = useState(ACTIVITY_PAGE_SIZE);
  const [activityTotal, setActivityTotal] = useState(0);
  const isToday = dateKey === todayKey;

  const [proofRisks, setProofRisks] = useState<Map<string, ProofRisk>>(
    new Map(),
  );

  const inflightRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const dateKeyRef = useRef(dateKey);
  const prevTodayKeyRef = useRef(todayKey);

  // Ba ref dưới đây để fetchOverview KHÔNG phải nhận dep nào đổi theo mỗi
  // lần chọn ngày / tải thêm. Nếu để dep thật, callback đổi danh tính →
  // effect poll dựng lại setInterval → nhịp 3 giây bị reset mỗi thao tác.
  const activityLimitRef = useRef(activityLimit);
  const isTodayRef = useRef(isToday);
  /**
   * "Lượt gọi tới BẮT BUỘC kèm nhật ký."
   *
   * Nhịp poll của một ngày quá khứ mặc định không kéo nhật ký về. Nhưng
   * lúc vừa đổi sang ngày đó — hoặc vừa bấm "Tải thêm" — thì đúng là phải
   * kéo. Nếu ngay lúc ấy đang có request bay và lượt này bị chặn bởi
   * inflight, cờ giữ lại ý định để nhịp kế tiếp làm nốt; không có cờ thì
   * bảng nhật ký của ngày quá khứ đứng trắng vĩnh viễn.
   */
  const forceActivityRef = useRef(true);

  useEffect(() => {
    activityLimitRef.current = activityLimit;
    isTodayRef.current = isToday;
  }, [activityLimit, isToday]);

  useEffect(() => {
    dateKeyRef.current = dateKey;
  }, [dateKey]);

  /**
   * Đổi ngày phải xoá dấu vết sự kiện đã thấy, nếu không toàn bộ nhật ký
   * ngày mới sẽ bị coi là "sự kiện vừa xảy ra" và nổ một tràng toast.
   */
  const goToDate = useCallback((next: string) => {
    if (!next) return;
    setDateKey(next);
    dateKeyRef.current = next;
    setActivityLimit(ACTIVITY_PAGE_SIZE);
    seenIdsRef.current = new Set();
    firstLoadRef.current = true;
    setFreshIds(new Set());
  }, []);

  const loadMoreActivity = useCallback(() => {
    // Dòng tải thêm là dòng CŨ hơn — không phải sự kiện mới, chặn toast.
    firstLoadRef.current = true;
    setActivityLimit((prev) =>
      Math.min(prev + ACTIVITY_PAGE_SIZE, ACTIVITY_MAX_LIMIT),
    );
  }, []);

  /**
   * Vẽ phần nhật ký của phản hồi overview.
   *
   * Tách khỏi hàm fetch vì nó còn phải quyết định "dòng nào là MỚI" để nổ
   * toast và nháy nền — logic đó bám vào seenIdsRef/firstLoadRef, không
   * liên quan gì đến chuyện lấy dữ liệu về bằng đường nào.
   */
  const applyActivity = useCallback(
    (act: ActivityResponse) => {
      if (act.date !== dateKeyRef.current) {
        // Server bác ngày client gửi (không có thật) và đã rơi về hôm nay:
        // kéo client theo, nếu không nhãn ngày và dữ liệu sẽ đứng lệch
        // nhau vĩnh viễn vì nhánh dưới cứ bỏ mọi phản hồi.
        if (act.invalid_date) goToDate(act.date);
        // Còn lại là phản hồi của ngày cũ về muộn sau khi người dùng đã
        // bấm sang ngày khác → bỏ, đừng vẽ dữ liệu ngày này dưới nhãn
        // ngày kia.
        return;
      }

      const wasFirstLoad = firstLoadRef.current;
      const newEvents: ActivityItem[] = [];
      for (const ev of act.activity) {
        if (!seenIdsRef.current.has(ev.id) && !wasFirstLoad) newEvents.push(ev);
      }
      seenIdsRef.current = new Set(act.activity.map((e) => e.id));

      setActivity(act.activity);
      setActivityTotal(act.total);
      setActivityError(null);
      firstLoadRef.current = false;

      // Chỉ hôm nay mới có "sự kiện vừa xảy ra". Xem lại ngày cũ mà nổ
      // toast + nháy dòng là báo động giả.
      if (!wasFirstLoad && isTodayRef.current && newEvents.length > 0) {
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
    },
    [toast, goToDate],
  );

  /**
   * MỘT request cho cả màn hình: KPI + bàn đóng hàng + cần xử lý + nhật ký.
   *
   * Trước đây mỗi nhịp 3 giây bắn 4 request riêng; nhịp giữ nguyên 3 giây
   * nhưng số request xuống còn 1/4. Người đứng ở kho không thấy khác gì.
   */
  const fetchOverview = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    const withActivity = forceActivityRef.current || isTodayRef.current;
    try {
      const qs = new URLSearchParams({
        date: dateKeyRef.current,
        issues_limit: "30",
        activity_limit: String(activityLimitRef.current),
        include_activity: withActivity ? "1" : "0",
      });
      const res = await fetch(`/api/returns/live/overview?${qs}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Endpoint giám sát trả lỗi");
      const data = (await res.json()) as OverviewResponse;

      setSummary(data.summary);
      setStations(data.stations.stations);
      setIssues(data.issues.issues);
      setError(null);
      setLastRefreshed(new Date());
      // Bảng treo qua đêm: ngày VN đổi thì thẻ KPI đã nhảy sang ngày mới,
      // nhật ký phải đi theo — nếu không màn hình kho im lặng đứng ở hôm qua.
      setTodayKey(vnDateKey());

      // Nhật ký hỏng KHÔNG được kéo theo cả màn hình: giữ đúng hai tầng lỗi
      // như hồi còn bốn endpoint rời.
      if (data.activity_error) setActivityError(data.activity_error);
      else if (data.activity) applyActivity(data.activity);

      // Chỉ hạ cờ khi request đã về tới nơi. Hỏng giữa chừng thì ý định
      // "phải kéo nhật ký" còn nguyên cho nhịp sau.
      if (withActivity) forceActivityRef.current = false;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflightRef.current = false;
    }
  }, [applyActivity]);

  useEffect(() => {
    void fetchOverview();
    return startVisibilityPolling({
      intervalMs: POLL_INTERVAL_MS,
      onTick: () => void fetchOverview(),
    });
  }, [fetchOverview]);

  // Người đang đứng ở "hôm nay" thì qua nửa đêm đi theo ngày mới; người
  // đang soi một ngày quá khứ thì giữ nguyên chỗ họ đang xem.
  useEffect(() => {
    if (prevTodayKeyRef.current !== todayKey) {
      const wasOnToday = dateKeyRef.current === prevTodayKeyRef.current;
      prevTodayKeyRef.current = todayKey;
      if (wasOnToday) goToDate(todayKey);
    }
  }, [todayKey, goToDate]);

  // Đổi ngày hoặc bấm "Tải thêm" → lượt gọi tới phải kèm nhật ký, kể cả
  // khi đang xem ngày quá khứ (nhịp poll ngày cũ mặc định bỏ qua nhật ký
  // vì nó không đổi nữa).
  useEffect(() => {
    forceActivityRef.current = true;
    void fetchOverview();
  }, [dateKey, activityLimit, fetchOverview]);

  // Nhịp riêng cho ước lượng dung lượng proof. Lỗi ở đây KHÔNG được
  // dựng banner đỏ toàn trang: đây là thông tin bổ trợ, mất nó không
  // ảnh hưởng giám sát chính.
  const refreshProofRisks = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/returns/live/proof-size-risk?date=${dateKey}&limit=60`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as ProofRiskResponse;
      const next = new Map<string, ProofRisk>();
      for (const r of data.risks) {
        if (r.raw_event_id) next.set(r.raw_event_id, r);
      }
      setProofRisks(next);
    } catch {
      // Im lặng: badge biến mất, phần còn lại của trang vẫn chạy.
    }
  }, [dateKey]);

  useEffect(() => {
    refreshProofRisks();
    // Ngày quá khứ: đơn đã đóng, ước lượng không đổi nữa — tải một lần.
    if (!isToday) return;
    return startVisibilityPolling({
      intervalMs: PROOF_RISK_POLL_INTERVAL_MS,
      onTick: refreshProofRisks,
    });
  }, [refreshProofRisks, isToday]);

  const visibleIssues = useMemo(
    () => issues.filter((i) => !dismissedIssueIds.has(i.id)),
    [issues, dismissedIssueIds],
  );

  const alerts = useMemo(
    () => computeAlerts(summary, visibleIssues),
    [summary, visibleIssues],
  );

  const filteredActivity = useMemo(
    () =>
      activity.filter((ev) =>
        matchActivityTab(ev, activeTab, proofRisks.get(ev.raw_event_id)),
      ),
    [activity, activeTab, proofRisks],
  );

  const onlineAgents = (summary?.agents ?? []).filter((a) => a.online).length;
  const totalAgents = (summary?.agents ?? []).length;
  const todayReceived = summary?.today.received ?? 0;
  const todayOk = summary?.today.ok ?? 0;
  const todayProblem = summary?.today.problem ?? 0;
  const todayOpen = summary?.today.open ?? 0;
  const todayDuplicated = summary?.today.duplicated ?? 0;
  const todaySuspect = summary?.today.suspect ?? 0;
  // Hồ sơ mở: việc phải làm trước khi hết hạn khiếu nại với sàn. Không bó
  // hôm nay — hồ sơ sống 7 ngày.
  const openClaims = summary?.today.open_claims ?? 0;
  const openStationId = stations.some(
    (station) => station.station_id === selectedStationId,
  )
    ? selectedStationId
    : "";

  const agentSummary =
    onlineAgents === totalAgents && totalAgents > 0
      ? `${onlineAgents}/${totalAgents} agent online`
      : `${onlineAgents}/${totalAgents} agent online — có agent mất kết nối`;

  return (
    <DashboardLayout
      pageTitle="Giám sát hoàn hàng"
      pageSubtitle={
        lastRefreshed
          ? `Cập nhật ${formatTime(lastRefreshed.toISOString())} · ${agentSummary}`
          : "Đang tải..."
      }
      pageIcon={PackageOpen}
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

        {/* Bật/tắt phiên nhận hoàn — tín hiệu module xuống agent. */}
        <ReturnCapturePanel />

        {/* 4 KPI cards — vận hành ưu tiên */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Đã nhận hôm nay"
            value={String(todayReceived)}
            hint={
              todayOpen > 0
                ? `${todayOk} hàng ổn · ${todayProblem} có vấn đề · ${todayOpen} đang mở`
                : `${todayOk} hàng ổn · ${todayProblem} có vấn đề`
            }
            icon={PackageCheck}
            tone="emerald"
          />
          <StatCard
            label="Quét lại"
            value={String(todayDuplicated)}
            hint={todayDuplicated > 0 ? "Kiện đã ghi hoàn trước đó" : "Không có kiện quét lại"}
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
              value={String(openClaims)}
              hint={
                openClaims > 0
                  ? `${openClaims} hồ sơ chưa khiếu nại${todaySuspect > 0 ? ` · ${todaySuspect} mã quay lại bàn đóng hàng` : ""}`
                  : todaySuspect > 0
                    ? `Không có hồ sơ mở · ${todaySuspect} mã quay lại bàn đóng hàng`
                    : "Không có hồ sơ cần xử lý"
              }
              icon={AlertTriangle}
              tone={openClaims > 0 ? "rose" : todaySuspect > 0 ? "amber" : "emerald"}
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
            <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  Bàn nhận hoàn
                </p>
                <p className="text-xs text-slate-500">
                  {stations.length} bàn ·{" "}
                  {stations.filter((s) => s.mode === "return").length} đang nhận hoàn ·{" "}
                  {stations.filter((s) => s.active_session).length} đang có người
                </p>
              </div>
              <div className="flex items-center gap-2">
                {stations.length > 0 && (
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                    <span className="sr-only">Chọn bàn để xem camera trực tiếp</span>
                    <select
                      value={openStationId}
                      onChange={(event) => setSelectedStationId(event.target.value)}
                      className="min-w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                      aria-label="Bàn nhận hoàn"
                    >
                      <option value="">Chọn bàn để xem trực tiếp</option>
                      {stations.map((station) => (
                        <option key={station.station_id} value={station.station_id}>
                          {station.station_code} · {station.station_name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <WarehouseIcon className="h-4 w-4 text-slate-400" />
              </div>
            </div>
            {stations.length === 0 ? (
              <p className="text-xs text-slate-500">Chưa có bàn nào được khai báo.</p>
            ) : (
              <div className="space-y-3">
                {openStationId && (
                  <div id="station-live-panel">
                    <StationLivePanel stationId={openStationId} />
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                  {stations.map((st) => (
                    <button
                      key={st.station_id}
                      type="button"
                      onClick={() => setSelectedStationId((current) =>
                        current === st.station_id ? "" : st.station_id,
                      )}
                      aria-expanded={openStationId === st.station_id}
                      aria-controls={
                        openStationId === st.station_id
                          ? "station-live-panel"
                          : undefined
                      }
                      className={`rounded-xl text-left transition ${
                        openStationId === st.station_id
                          ? "ring-2 ring-emerald-400 ring-offset-1"
                          : "hover:ring-1 hover:ring-slate-200"
                      }`}
                    >
                      <StationCardView st={st} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Issues 2/5 */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 lg:px-5 border-b border-slate-100">
              <div>
                <p className="text-sm font-semibold text-slate-800">Cần xử lý</p>
                <p className="text-xs text-slate-500">
                  {visibleIssues.length} mục cần làm
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
                    Không có kiện hoàn nào cần xử lý.
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
                {isToday
                  ? "Hoạt động hôm nay"
                  : `Hoạt động ngày ${formatDateKeyVn(dateKey)}`}
              </p>
              <p className="text-xs text-slate-500">
                {activityTotal > 0
                  ? `${activityTotal} kiện hoàn và lượt quét thẻ trong ngày, mới nhất ở trên`
                  : "Tất cả kiện hoàn và lượt quét thẻ trong ngày, mới nhất ở trên"}
                {activityError ? ` · ${activityError}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex items-center rounded-xl border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => goToDate(shiftDateKey(dateKey, -1))}
                  title="Ngày trước"
                  aria-label="Ngày trước"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <label className="inline-flex items-center gap-1.5 px-1.5 cursor-pointer">
                  <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="date"
                    value={dateKey}
                    max={todayKey}
                    onChange={(e) => goToDate(e.target.value)}
                    className="text-xs font-semibold text-slate-700 bg-transparent outline-none cursor-pointer"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => goToDate(shiftDateKey(dateKey, 1))}
                  disabled={isToday}
                  title="Ngày sau"
                  aria-label="Ngày sau"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              {!isToday && (
                <button
                  type="button"
                  onClick={() => goToDate(todayKey)}
                  className="h-8 px-3 rounded-xl text-xs font-semibold text-slate-600 border border-slate-200 hover:bg-slate-50"
                >
                  Về hôm nay
                </button>
              )}
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
          </div>
          {!isToday && (
            <div className="px-4 lg:px-5 py-2 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-800 flex items-start gap-2">
              <History className="h-3.5 w-3.5 mt-px shrink-0" />
              <span>
                Đang xem lại ngày {formatDateKeyVn(dateKey)} — bảng này không tự
                cập nhật. Thẻ số, bàn nhận hoàn và panel &ldquo;Cần xử lý&rdquo;
                phía trên vẫn là hôm nay.
              </span>
            </div>
          )}
          <div>
            {filteredActivity.length === 0 ? (
              <p className="text-xs text-slate-500 p-4 text-center">
                {activity.length === 0
                  ? isToday
                    ? "Hôm nay chưa có kiện hoàn nào."
                    : `Ngày ${formatDateKeyVn(dateKey)} không có kiện hoàn nào.`
                  : "Không có hoạt động phù hợp với bộ lọc đang chọn."}
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
                    const proofRisk = proofRisks.get(ev.raw_event_id);
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
                            <span className="text-amber-600 font-medium">đang mở</span>
                          ) : ev.timing_status === "capped_timeout" ? (
                            // Amber, không phải rose: đây là anomaly nghiệp
                            // vụ (đơn đóng lâu hơn ngưỡng cấu hình), không
                            // phải lỗi hệ thống. "quá lâu" cũ dễ đọc thành
                            // "hệ thống hỏng".
                            <span
                              className="text-amber-600 font-medium"
                              title="Vượt thời gian đóng gói cấu hình — thời gian hiển thị là ngưỡng, không phải số đo được"
                            >
                              vượt ngưỡng
                            </span>
                          ) : ev.timing_status === "default_estimated" ? (
                            <span
                              className="text-slate-500 font-medium italic"
                              title="Không đo được (ra ca quá muộn sau đơn cuối) — số này là ước lượng cấu hình"
                            >
                              ước lượng
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
                        <td className="px-4 py-2 text-xs text-slate-500">
                          {ev.note && (
                            <span className="block truncate" title={ev.note}>
                              {ev.note}
                            </span>
                          )}
                          <ProofSizeBadge risk={proofRisk} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {activity.length < activityTotal && (
            <div className="border-t border-slate-100 px-4 lg:px-5 py-3 flex items-center justify-center gap-3 flex-wrap">
              <p className="text-xs text-slate-500">
                Đang hiển thị {activity.length} / {activityTotal} sự kiện của
                ngày (mới nhất trước).
              </p>
              {activityLimit < ACTIVITY_MAX_LIMIT ? (
                <button
                  type="button"
                  onClick={loadMoreActivity}
                  className="h-8 px-3 rounded-xl text-xs font-semibold text-slate-700 border border-slate-200 hover:bg-slate-50"
                >
                  Tải thêm
                </button>
              ) : (
                // Nói thẳng phần bị cắt. Trần im lặng đọc thành "đã xem hết
                // ngày" trong khi còn hàng trăm đơn chưa hiện.
                <span className="text-xs text-amber-700">
                  Đã tới trần {ACTIVITY_MAX_LIMIT} dòng — {activityTotal - activity.length}{" "}
                  sự kiện đầu ngày chưa hiện. Dùng Bằng chứng hoàn hàng để tra
                  cứu cả ngày.
                </span>
              )}
            </div>
          )}
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

/**
 * Nhãn chế độ bàn. Bàn đang ở chế độ đóng hàng thì không có nhãn — thẻ
 * trông y như bên Giám sát đóng hàng.
 */
function ModeChip({ st }: { st: StationCard }) {
  if (st.mode !== "return") return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-700 bg-violet-100 px-1.5 py-0.5 rounded">
      <Radio className="h-3 w-3" />
      {st.capture_state === "active" ? "Đang nhận hoàn · ghi hình" : "Đang nhận hoàn"}
    </span>
  );
}

function StationCardView({ st }: { st: StationCard }) {
  const sess = st.active_session;
  const inReturn = st.mode === "return";
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
          Hôm nay <span className="font-semibold text-slate-700">{st.packing_count_today}</span> kiện
        </p>
        {inReturn && (
          <div className="mt-1.5">
            <ModeChip st={st} />
          </div>
        )}
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
            kiện / phiên
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Activity className="h-3 w-3 text-slate-400" />
          <span>{sess.scans_per_hour} kiện/giờ</span>
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

      {(sess.errors_in_session > 0 || idle || inReturn) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <ModeChip st={st} />
          {sess.errors_in_session > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
              <AlertTriangle className="h-3 w-3" />
              {sess.errors_in_session} kiện có vấn đề trong phiên
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
          Hôm nay <span className="font-semibold text-slate-700">{st.packing_count_today}</span> kiện
        </span>
        <ChevronRight className="h-3 w-3" />
      </div>
    </div>
  );
}
