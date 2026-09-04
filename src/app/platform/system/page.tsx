"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  Camera,
  CheckCircle2,
  ChevronRight,
  Database,
  Gauge,
  HardDrive,
  HelpCircle,
  Loader2,
  Moon,
  Network,
  RefreshCw,
  Search,
  Timer,
  XCircle,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";

/**
 * Trang tình trạng hạ tầng.
 *
 * VÌ SAO Ở /platform CHỨ KHÔNG /dashboard/system (đề bài ghi /dashboard):
 * middleware chặn đúng người cần xem. src/lib/supabase/proxy.ts:108-149 —
 * platform admin vào /dashboard/* mà không có organization_id trong JWT và
 * không có cookie impersonate thì bị redirect thẳng về /platform.
 *
 * BỐ CỤC theo đúng thứ tự câu hỏi của người trực:
 *   1. Dòng kết luận + sáu ô số  → "có phải làm gì không"
 *   2. Cần chú ý                 → "việc gì, ở đâu, làm sao"
 *   3. Kho đang vận hành         → "nhiều kho thì kho nào ra sao"
 *   4. Hạ tầng + Chưa giám sát   → "còn gì chưa được canh"
 *
 * MỘT LUẬT CỨNG CHO CẢ FILE: không con số nào ở đây được sinh ra tại chỗ.
 * Mọi thứ hiện lên đều đến từ /api/system/status, và mọi thứ ở đó đều đếm
 * từ dữ liệu thật. Ô "12/14" trông đẹp hơn "1/1" rất nhiều — đó chính là
 * lý do phải cấm, vì người trực vẫn tin con số đẹp đó và tin nhầm.
 */

type CheckStatus = "ok" | "warn" | "crit" | "unknown" | "skipped";
type IssueStatus = "crit" | "warn" | "unknown";

interface SystemCheck {
  key: string;
  status: CheckStatus;
  value: string;
  message: string;
  unknownKind?: "structural" | "incident";
}

interface HeroStat {
  key: string;
  label: string;
  /** null = không đo được lượt này — hiện "—", TUYỆT ĐỐI không hiện 0. */
  value: number | null;
  total: number | null;
  hint: string;
  tone: CheckStatus;
}

interface SystemIssue {
  id: string;
  checkKey: string;
  status: IssueStatus;
  where: string;
  what: string;
  symptom: string;
  action: string;
  href: string | null;
}

interface OrgHealth {
  orgId: string;
  orgName: string;
  warehouseNames: string[];
  /** Mốc đơn hàng cuối được quét — đồng hồ thật của kho. */
  lastScanAt: string | null;
  status: CheckStatus;
  agents: Array<{ id: string; code: string; status: CheckStatus; detail: string }>;
  cameras: { total: number; failingLong: number; failingShort: number; stale: number };
  recording: { status: CheckStatus; detail: string } | null;
  clipFailures: { status: CheckStatus; count: number; detail: string } | null;
}

interface InfraTile {
  key: string;
  label: string;
  status: CheckStatus;
  value: string;
  detail: string;
}

interface StatusResponse {
  checked_at: string;
  worst: CheckStatus;
  checks: SystemCheck[];
  hero: HeroStat[];
  issues: SystemIssue[];
  orgs: OrgHealth[];
  infra: InfraTile[];
  unavailable: SystemCheck[];
  last_background_run: string | null;
}

const LABELS: Record<string, string> = {
  supabase_egress: "Egress Supabase",
  cron_cleanup: "Cron dọn clip",
  cron_orphan_segments: "Cron dọn segment mồ côi",
  agent_heartbeat: "Kết nối agent kho",
  camera_probe: "Camera",
  recording_freshness: "Ghi hình",
  clip_failures: "Clip đơn hàng",
  vps_resources: "Ổ đĩa + RAM VPS",
  storage_usage: "Dung lượng Storage",
  warehouse_disk: "Ổ đĩa máy kho",
};

const HERO_ICON: Record<string, typeof Building2> = {
  warehouses: Building2,
  agents: Network,
  cameras: Camera,
  incidents: AlertTriangle,
  warnings: Bell,
  blindspots: HelpCircle,
};

const INFRA_ICON: Record<string, typeof Gauge> = {
  self_check: Activity,
  supabase: Database,
  cron_cleanup: Timer,
  vps_resources: HardDrive,
};

const TONE: Record<
  CheckStatus,
  { chip: string; dot: string; soft: string; text: string; label: string; Icon: typeof CheckCircle2 }
> = {
  ok: {
    chip: "bg-emerald-100 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
    soft: "bg-emerald-50 text-emerald-600",
    text: "text-emerald-600",
    label: "Bình thường",
    Icon: CheckCircle2,
  },
  warn: {
    chip: "bg-amber-100 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
    soft: "bg-amber-50 text-amber-600",
    text: "text-amber-600",
    label: "Cảnh báo",
    Icon: AlertTriangle,
  },
  crit: {
    chip: "bg-red-100 text-red-700 border-red-200",
    dot: "bg-red-500",
    soft: "bg-red-50 text-red-600",
    text: "text-red-600",
    label: "Nghiêm trọng",
    Icon: XCircle,
  },
  unknown: {
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
    soft: "bg-slate-100 text-slate-500",
    text: "text-slate-500",
    label: "Chưa rõ",
    Icon: HelpCircle,
  },
  // Tông chàm nhạt, KHÔNG dùng lại tông xám của "Chưa rõ": hai trạng thái
  // này nói hai chuyện khác nhau (ngoài ca vs mất nguồn dữ liệu) và người
  // trực phải phân biệt được từ xa mà không cần đọc chữ.
  skipped: {
    chip: "bg-indigo-100 text-indigo-700 border-indigo-200",
    dot: "bg-indigo-400",
    soft: "bg-indigo-50 text-indigo-600",
    text: "text-indigo-600",
    label: "Ngoài giờ",
    Icon: Moon,
  },
};

function formatVn(iso: string | null): string {
  if (!iso) return "chưa có";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "chưa có";
  return d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}

/** "3 phút trước" — cho biết mốc còn tươi hay đã cũ mà không phải trừ tay. */
function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

function percent(value: number | null, total: number | null): string | null {
  // Không đo được thì KHÔNG có phần trăm. Bản trước hiện "0%" màu xanh cho
  // một kho đang đóng cửa — con số đó vừa sai vừa trấn an nhầm.
  if (value === null || total === null || total <= 0) return null;
  return `${Math.round((value / total) * 1000) / 10}%`;
}

// ── Ô số tổng ─────────────────────────────────────────────────────────

function HeroCard({ stat }: { stat: HeroStat }) {
  const tone = TONE[stat.tone];
  const Icon = HERO_ICON[stat.key] ?? Activity;
  const pct = percent(stat.value, stat.total);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className={`h-10 w-10 rounded-xl grid place-items-center shrink-0 ${tone.soft}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-slate-500">{stat.label}</p>
          <p className="mt-0.5 text-slate-800">
            <span className={`text-2xl font-semibold ${stat.value === null ? "text-slate-300" : ""}`}>
              {stat.value === null ? "—" : stat.value}
            </span>
            {stat.total !== null && (
              <span className="text-sm text-slate-400"> / {stat.total}</span>
            )}
          </p>
        </div>
      </div>
      <p className={`mt-2 text-xs ${tone.text}`}>
        {pct && <span className="font-medium">{pct} · </span>}
        {stat.hint}
      </p>
    </div>
  );
}

// ── Ô camera trong bảng kho ───────────────────────────────────────────

function CameraCell({ c }: { c: OrgHealth["cameras"] }) {
  if (c.total === 0) return <span className="text-xs text-slate-400">chưa khai camera</span>;
  const bad: string[] = [];
  if (c.failingLong > 0) bad.push(`${c.failingLong} lỗi kéo dài`);
  if (c.failingShort > 0) bad.push(`${c.failingShort} vừa lỗi`);
  if (c.stale > 0) bad.push(`${c.stale} số liệu cũ`);
  const ok = c.total - c.failingLong - c.failingShort - c.stale;
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${bad.length ? "bg-amber-500" : "bg-emerald-500"}`} />
        <span className="text-slate-700">
          {ok} / {c.total} hoạt động
        </span>
      </div>
      <div className={`mt-0.5 ${bad.length ? "text-amber-700" : "text-slate-400"}`}>
        {bad.length > 0 ? bad.join(" · ") : "không có camera lỗi"}
      </div>
    </div>
  );
}

/** Ô hai dòng dùng chung cho cột Recording và Clip lỗi. */
function StatusCell({
  status,
  head,
  sub,
}: {
  status: CheckStatus | null;
  head: string;
  sub: string;
}) {
  if (status === null) {
    return <span className="text-xs text-slate-400">không kết luận</span>;
  }
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${TONE[status].dot}`} />
        <span className="text-slate-700">{head}</span>
      </div>
      <div className="mt-0.5 text-slate-400 line-clamp-2">{sub}</div>
    </div>
  );
}

export default function SystemStatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | CheckStatus>("all");

  // KHÔNG setLoading(true) ở đầu hàm: lượt đầu do effect gọi, mà state
  // `loading` đã khởi tạo true rồi — bật lại đồng bộ trong thân effect là
  // một vòng render thừa (react-hooks/set-state-in-effect). Nút bấm tự bật
  // spinner trước khi gọi.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/system/status", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? json.error ?? "Không tải được tình trạng hệ thống.");
        setData(null);
      } else {
        setData(json as StatusResponse);
        setError("");
      }
    } catch (err) {
      // Mạng rớt cũng phải nói ra chứ không để trang treo ở "Đang tải".
      setError(err instanceof Error ? err.message : "Lỗi mạng.");
      setData(null);
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, []);

  // Chỉ tải một lần khi mở + khi bấm nút. KHÔNG tự động lặp: cảnh báo là
  // việc của Lark, trang này không nên tự gọi lại nền vô hạn.
  useEffect(() => {
    void load();
  }, [load]);

  const orgs = useMemo(() => {
    const all = data?.orgs ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (!q) return true;
      return (
        o.orgName.toLowerCase().includes(q) ||
        o.warehouseNames.some((n) => n.toLowerCase().includes(q)) ||
        o.agents.some((a) => a.code.toLowerCase().includes(q))
      );
    });
  }, [data, query, statusFilter]);

  const critCount = data?.issues.filter((i) => i.status === "crit").length ?? 0;
  const attention = data?.issues ?? [];

  return (
    <PlatformLayout
      pageTitle="Tình trạng hệ thống"
      pageSubtitle="Cảnh báo thật gửi qua Lark — trang này để xem lại và tra chi tiết."
      pageIcon={Activity}
    >
      <div className="p-4 sm:p-6 space-y-5">
        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : data ? (
          <>
            {/* ── Dòng kết luận ─────────────────────────────────────── */}
            <div
              className={`rounded-2xl border p-5 flex flex-wrap items-center gap-4 ${
                attention.length === 0
                  ? "border-emerald-100 bg-emerald-50/50"
                  : critCount > 0
                    ? "border-red-200 bg-red-50/60"
                    : "border-amber-200 bg-amber-50/50"
              }`}
            >
              <span
                className={`h-11 w-11 rounded-full grid place-items-center shrink-0 text-white ${
                  attention.length === 0
                    ? "bg-emerald-500"
                    : critCount > 0
                      ? "bg-red-500"
                      : "bg-amber-500"
                }`}
              >
                {(() => {
                  const Icon = TONE[data.worst].Icon;
                  return <Icon className="h-6 w-6" />;
                })()}
              </span>
              <div className="min-w-0">
                <p className="text-base font-semibold text-slate-800">
                  {attention.length === 0
                    ? data.worst === "skipped"
                      ? "Mọi kho đang ngoài giờ vận hành"
                      : "Hệ thống hoạt động bình thường"
                    : critCount > 0
                      ? `${critCount} sự cố đang mở`
                      : `${attention.length} mục cần chú ý`}
                </p>
                <p className="text-sm text-slate-600">
                  {attention.length === 0
                    ? data.worst === "skipped"
                      ? "Không mục nào được kiểm lượt này — trang không chứng minh được điều gì."
                      : "Mọi mục đo được đều bình thường. Phần chưa đo được liệt kê ở cuối trang."
                    : "Mỗi dòng bên dưới là một đối tượng cụ thể và một việc phải làm."}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-slate-500 hidden sm:inline">
                  Kiểm lúc {formatVn(data.checked_at)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    void load();
                  }}
                  disabled={loading}
                  className="h-9 px-4 rounded-xl border border-slate-200 bg-white text-slate-600 text-sm font-medium inline-flex items-center gap-2 hover:bg-slate-50 disabled:opacity-60"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Kiểm lại
                </button>
              </div>
            </div>

            {/* ── Sáu ô số ──────────────────────────────────────────── */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {data.hero.map((s) => (
                <HeroCard key={s.key} stat={s} />
              ))}
            </div>

            {/* ── Cần chú ý ─────────────────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-800">Cần chú ý</h2>
                <span
                  className={`h-6 px-2 rounded-lg text-[11px] font-semibold inline-flex items-center border ${
                    attention.length === 0 ? TONE.ok.chip : TONE[data.worst].chip
                  }`}
                >
                  {attention.length === 0 ? "không có việc" : `${attention.length} mục`}
                </span>
              </div>
              {attention.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                  Không có sự cố nào đang mở.
                </div>
              ) : (
                <ul className="space-y-2">
                  {attention.map((i) => {
                    const tone = TONE[i.status];
                    return (
                      <li
                        key={i.id}
                        className={`rounded-2xl border p-4 flex flex-wrap items-start gap-3 ${
                          i.status === "crit"
                            ? "border-red-200 bg-red-50/50"
                            : i.status === "warn"
                              ? "border-amber-200 bg-amber-50/40"
                              : "border-slate-200 bg-white"
                        }`}
                      >
                        <span className={`h-9 w-9 rounded-xl grid place-items-center shrink-0 ${tone.soft}`}>
                          <tone.Icon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-semibold text-slate-800">
                              {i.where} — {i.what}
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {LABELS[i.checkKey] ?? i.checkKey}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-slate-600">{i.symptom}</p>
                          {/* Việc cần làm tách riêng khỏi triệu chứng: gộp cả
                              hai vào một câu thì người trực phải tự suy ra
                              bước tiếp theo. */}
                          <p className="mt-1 text-xs leading-relaxed text-slate-800">
                            <span className="text-slate-400">Cần làm: </span>
                            {i.action}
                          </p>
                        </div>
                        {i.href && (
                          <Link
                            href={i.href}
                            className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-medium inline-flex items-center gap-1 hover:bg-slate-50 shrink-0"
                          >
                            Xem chi tiết
                            <ChevronRight className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* ── Kho đang vận hành ─────────────────────────────────── */}
            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-100">
                <h2 className="text-base font-semibold text-slate-800">Kho đang vận hành</h2>
                <span className="h-6 px-2 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-semibold inline-flex items-center">
                  {data.orgs.length} kho
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Tìm kho, mã agent…"
                      className="h-9 pl-9 pr-3 w-56 rounded-xl border border-slate-200 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as "all" | CheckStatus)}
                    className="h-9 px-3 rounded-xl border border-slate-200 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="all">Tất cả trạng thái</option>
                    <option value="crit">Nghiêm trọng</option>
                    <option value="warn">Cảnh báo</option>
                    <option value="unknown">Chưa rõ</option>
                    <option value="ok">Bình thường</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[62rem]">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                      <th className="font-medium px-4 py-2.5">Kho</th>
                      <th className="font-medium px-4 py-2.5">Trạng thái</th>
                      <th className="font-medium px-4 py-2.5">Agent</th>
                      <th className="font-medium px-4 py-2.5">Camera</th>
                      <th className="font-medium px-4 py-2.5">Ghi hình</th>
                      <th className="font-medium px-4 py-2.5">Clip lỗi</th>
                      <th className="font-medium px-4 py-2.5">Đơn cuối</th>
                      <th className="font-medium px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-500">
                          {data.orgs.length === 0
                            ? "Không tổ chức nào đang bật theo dõi, hoặc không đọc được danh sách."
                            : "Không kho nào khớp bộ lọc."}
                        </td>
                      </tr>
                    ) : (
                      orgs.map((o) => {
                        const tone = TONE[o.status];
                        return (
                          <tr
                            key={o.orgId}
                            className="border-b border-slate-50 last:border-0 align-top"
                          >
                            <td className="px-4 py-3">
                              <div className="font-medium text-slate-800">{o.orgName}</div>
                              {o.warehouseNames.length > 0 && (
                                <div className="text-xs text-slate-500 mt-0.5">
                                  {o.warehouseNames.join(", ")}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-flex items-center gap-1 h-6 px-2 rounded-lg border text-[11px] font-semibold ${tone.chip}`}
                              >
                                <tone.Icon className="h-3 w-3" />
                                {tone.label}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {o.agents.length === 0 ? (
                                <span className="text-xs text-slate-400">chưa cài agent</span>
                              ) : (
                                <ul className="space-y-1">
                                  {o.agents.map((a) => (
                                    <li key={a.id} className="text-xs">
                                      <div className="flex items-center gap-1.5">
                                        <span
                                          className={`h-1.5 w-1.5 rounded-full shrink-0 ${TONE[a.status].dot}`}
                                        />
                                        <span className="font-mono text-slate-700 break-all">
                                          {a.code}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 text-slate-400">{a.detail}</div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <CameraCell c={o.cameras} />
                            </td>
                            <td className="px-4 py-3">
                              <StatusCell
                                status={o.recording?.status ?? null}
                                head={
                                  o.recording?.status === "ok"
                                    ? "Bám hoạt động"
                                    : o.recording?.status === "unknown"
                                      ? "Chưa có mốc"
                                      : "Lỡ nhịp"
                                }
                                sub={o.recording?.detail ?? ""}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <StatusCell
                                status={o.clipFailures?.status ?? null}
                                head={`${o.clipFailures?.count ?? 0} clip`}
                                sub={o.clipFailures?.detail ?? ""}
                              />
                            </td>
                            {/*
                              Thay cột "Giờ vận hành" của bản trước. Đây là
                              mốc để đọc mọi ô còn lại: agent im 3 tiếng mà
                              đơn cuối cũng 3 tiếng trước = kho đã nghỉ; đơn
                              cuối 5 phút trước = kho đang chạy, agent đang chết.
                            */}
                            <td className="px-4 py-3 text-xs">
                              {o.lastScanAt ? (
                                <>
                                  <div className="text-slate-700">{ago(o.lastScanAt, now)}</div>
                                  <div className="mt-0.5 text-slate-400">
                                    {formatVn(o.lastScanAt)}
                                  </div>
                                </>
                              ) : (
                                <span className="text-slate-400">chưa đóng gói đơn nào</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <Link
                                href={`/platform/orgs/${o.orgId}`}
                                className="h-8 px-3 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium inline-flex items-center gap-1 hover:bg-slate-50 whitespace-nowrap"
                              >
                                Xem chi tiết
                                <ChevronRight className="h-3.5 w-3.5" />
                              </Link>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {data.orgs.length > 0 && (
                <div className="px-4 py-3 text-xs text-slate-500 border-t border-slate-100">
                  Hiển thị {orgs.length} trong {data.orgs.length} kho đang bật theo dõi. Mọi kết
                  luận đối chiếu với cột &ldquo;Đơn cuối&rdquo; — hệ không dùng khung giờ khai
                  báo, kho nghỉ thì tự im.
                </div>
              )}
            </section>

            {/* ── Hạ tầng + Chưa giám sát được ──────────────────────── */}
            <div className="grid gap-4 xl:grid-cols-3">
              <section className="xl:col-span-2 rounded-2xl border border-slate-200 bg-white p-4">
                <h2 className="text-base font-semibold text-slate-800">Hạ tầng Betabox</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Không thuộc kho nào. Mọi số ở đây đo trong chính lượt kiểm này — hệ chưa ghi lịch
                  sử uptime nên không có ô phần trăm nào.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {data.infra.map((t) => {
                    const tone = TONE[t.status];
                    const Icon = INFRA_ICON[t.key] ?? Gauge;
                    return (
                      <div
                        key={t.key}
                        className={`rounded-xl border p-3 ${
                          t.status === "ok" || t.status === "skipped"
                            ? "border-slate-200 bg-white"
                            : t.status === "warn"
                              ? "border-amber-200 bg-amber-50/60"
                              : t.status === "crit"
                                ? "border-red-200 bg-red-50/60"
                                : "border-slate-200 bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Icon className={`h-4 w-4 ${tone.text}`} />
                          <span className="text-sm font-semibold text-slate-800">{t.label}</span>
                        </div>
                        <div className={`mt-1.5 text-xs font-medium ${tone.text}`}>{tone.label}</div>
                        <div className="text-sm text-slate-700">{t.value}</div>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-500 line-clamp-3">
                          {t.detail}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/*
                Phần CHƯA theo dõi được. Vẫn phải có mặt: một trang toàn xanh
                mà giấu luôn phần chưa canh sẽ bị đọc thành "đã phủ hết", và
                đó chính là cách sự cố egress 103% xảy ra lần đầu. Nhưng nó
                là DANH SÁCH ở góc, không phải card to giữa lưới chính.
              */}
              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-slate-800">Chưa giám sát được</h2>
                  <span className="h-6 px-2 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-semibold inline-flex items-center">
                    {data.unavailable.length} mục
                  </span>
                </div>
                <ul className="mt-3 divide-y divide-slate-50">
                  {data.unavailable.map((c) => (
                    <li key={c.key} className="py-3 flex items-start gap-3">
                      <span className="h-8 w-8 rounded-lg bg-slate-100 text-slate-400 grid place-items-center shrink-0">
                        <HelpCircle className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-700">
                          {LABELS[c.key] ?? c.key}
                        </p>
                        <p className="text-xs text-slate-400">{c.value}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 pt-3 border-t border-slate-100 text-[11px] leading-relaxed text-slate-500">
                  Không mục nào trong số này gửi cảnh báo — phải xem tay ở dashboard Supabase. Chúng
                  ở đây để không ai đọc một trang toàn xanh thành &ldquo;đã phủ hết&rdquo;.
                </p>
              </section>
            </div>

            <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500 pt-1">
              <ArrowRight className="h-3.5 w-3.5 text-slate-300" />
              Lần tự kiểm nền gần nhất:{" "}
              <span className="font-medium text-slate-700">
                {formatVn(data.last_background_run)}
              </span>{" "}
              {ago(data.last_background_run, now)} · systemd timer chạy mỗi 15 phút. Mốc này cũ hơn
              nhiều thì chính con cảnh báo đã chết, không phải hệ đang yên.
            </div>
          </>
        ) : null}
      </div>
    </PlatformLayout>
  );
}
