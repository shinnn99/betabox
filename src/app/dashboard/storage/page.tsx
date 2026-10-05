"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  CheckCircle2,
  Database,
  HardDrive,
  Info,
  Lightbulb,
  Loader2,
  RefreshCw,
  Settings,
  Video,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Select from "@/components/ui/Select";
import { formatVn } from "@/lib/format/time-vn";

/**
 * Sức chứa bằng chứng của kho.
 *
 * THỨ TỰ TRÌNH BÀY, ngược với trang platform có chủ đích:
 *   1. Cảnh báo        → "tôi có phải làm gì không"
 *   2. Ổ đĩa máy kho   → nơi giữ BẰNG CHỨNG THẬT, ổ đầy là mất thật
 *   3. Ghi theo ngày   → nhịp thật, để tự thấy vì sao ổ hết nhanh
 *   4. Clip máy chủ    → cuối, vì hết hạn ở đây KHÔNG mất gì
 *
 * Trang platform xếp Supabase lên đầu vì ở đó câu hỏi là tiền. Ở đây câu hỏi
 * là bằng chứng, nên ổ kho lên đầu. Đảo lại là dạy người quản kho lo nhầm chỗ.
 */

interface AgentDiskView {
  agentId: string;
  code: string | null;
  name: string | null;
  online: boolean;
  lastSeenAt: string | null;
  reportAt: string | null;
  disk: {
    freeBytes: number;
    totalBytes: number;
    usedBytes: number;
    recordingBytes: number | null;
    freePct: number;
    bytesPerDay: number | null;
    daysLeft: number | null;
    capacityDays: number | null;
  } | null;
}

interface DailyRow {
  day: string;
  segments: number;
  bytes: number;
  /** Đã đóng file mà không có dung lượng → sẽ không bao giờ có. */
  segmentsWithoutSize: number;
  /** Đang quay ngay lúc đọc — chưa có dung lượng là đúng, không phải thiếu. */
  segmentsRecording: number;
}

interface StorageHealth {
  retentionDays: number | null;
  agents: AgentDiskView[];
  daily: DailyRow[];
  bucket: { ttlHours: number; clips: number; bytes: number };
  warnings: Array<{
    kind: string;
    severity: "crit" | "warn";
    agentCode: string | null;
    message: string;
    action: string;
  }>;
}

const CONFIG_HREF = "/dashboard/settings/warehouse-config";

function size(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

const WINDOW_OPTIONS = [
  { value: "14", label: "14 ngày gần nhất" },
  { value: "7", label: "7 ngày gần nhất" },
];

export default function WarehouseStoragePage() {
  const [data, setData] = useState<StorageHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [windowDays, setWindowDays] = useState("14");

  // KHÔNG setLoading(true) ở đầu: lượt đầu do effect gọi mà `loading` đã khởi
  // tạo true (react-hooks/set-state-in-effect). Nút tự bật spinner.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/warehouse/storage", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? json.error ?? "Không tải được dung lượng lưu trữ.");
        setData(null);
      } else {
        setData(json as StorageHealth);
        setError("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi mạng.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const primary = data?.agents[0] ?? null;
  const daily = (data?.daily ?? []).slice(0, Number(windowDays));
  const maxDaily = daily.reduce((n, d) => Math.max(n, d.bytes), 0);
  // SỐ VIDEO THẬT, không phải số dòng sổ. Những ngày bị ghi trùng có mỗi video
  // hai dòng (xem chú thích dưới biểu đồ), nên `segments` của ngày đó đếm gấp
  // đôi. Trừ phần trùng ra, nếu không ô này nói "744 video" cho một ngày thực
  // chất chỉ quay 372 — và người đọc không có cách nào biết.
  const totalSegments = daily.reduce((n, d) => n + d.segments - d.segmentsWithoutSize, 0);
  const totalBytes = daily.reduce((n, d) => n + d.bytes, 0);
  const partialDays = daily.filter((d) => d.segmentsWithoutSize > 0).length;
  const recordingNow = daily.reduce((n, d) => n + d.segmentsRecording, 0);

  return (
    <DashboardLayout
      pageTitle="Dung lượng lưu trữ"
      pageSubtitle="Bằng chứng của kho còn giữ được bao lâu nữa"
      pageIcon={HardDrive}
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !data ? null : (
          <>
            {/* ── Cảnh báo ───────────────────────────────────────── */}
            {data.warnings.length === 0 ? (
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4 flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
                <p className="text-sm text-slate-700">
                  Dung lượng đang bình thường — không có việc gì phải làm.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {data.warnings.map((w, i) => (
                  <WarningBanner key={`${w.kind}-${w.agentCode ?? i}`} warning={w} />
                ))}
              </div>
            )}

            {/* ── Ổ đĩa: thẻ lớn + bảng thông tin ────────────────── */}
            <div className="grid gap-4 lg:grid-cols-3">
              <section className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white">
                <div className="p-4 flex flex-wrap items-center gap-2 border-b border-slate-100">
                  <Database className="h-4 w-4 text-slate-500" />
                  <h2 className="text-base font-semibold text-slate-800">Tổng ổ đĩa &amp; thư mục video</h2>
                  {primary && (
                    <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-lg bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          primary.online ? "bg-emerald-500" : "bg-slate-300"
                        }`}
                      />
                      {primary.code ?? "—"}
                    </span>
                  )}
                  <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setLoading(true);
                        void load();
                      }}
                      disabled={loading}
                      className="h-9 px-3 rounded-xl border border-slate-200 bg-white text-slate-700 text-sm font-medium inline-flex items-center gap-2 hover:bg-slate-50 disabled:opacity-60"
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Kiểm lại
                    </button>
                    <p className="text-[11px] text-slate-400">
                      Cập nhật: {primary?.reportAt ? formatVn(primary.reportAt) : "chưa báo"}
                    </p>
                  </div>
                </div>

                {!primary ? (
                  <p className="p-6 text-sm text-slate-500">
                    Kho chưa có máy trạm nào đang hoạt động.
                  </p>
                ) : !primary.disk ? (
                  // Chưa tự khai thì nói CHƯA BIẾT, không vẽ vòng 0% — vòng
                  // rỗng đọc như ổ trống, mà sự thật là không có số liệu.
                  <p className="p-6 text-sm text-slate-500">
                    Máy kho này chưa báo dung lượng ổ đĩa (cần bản 0.13.0 trở lên).
                  </p>
                ) : (
                  <DiskPanel disk={primary.disk} retentionDays={data.retentionDays} />
                )}
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white">
                <div className="p-4 flex items-center gap-2 border-b border-slate-100">
                  <HardDrive className="h-4 w-4 text-slate-500" />
                  <h2 className="text-base font-semibold text-slate-800">Thông tin ổ đĩa</h2>
                </div>
                {primary?.disk ? (
                  <>
                    <dl className="p-4 space-y-2.5 text-sm">
                      <InfoRow label="Tên máy kho" value={primary.code ?? "—"} mono />
                      <InfoRow label="Tổng dung lượng" value={size(primary.disk.totalBytes)} />
                      <InfoRow
                        label="Đã sử dụng"
                        value={`${size(primary.disk.usedBytes)} (${(100 - primary.disk.freePct).toFixed(1)}%)`}
                        tone={primary.disk.freePct < 15 ? "danger" : "default"}
                      />
                      <InfoRow
                        label="Còn trống"
                        value={`${size(primary.disk.freeBytes)} (${primary.disk.freePct}%)`}
                      />
                      <InfoRow
                        label="Thư mục lưu video"
                        value={
                          primary.disk.recordingBytes === null
                            ? "chưa có số liệu"
                            : `${size(primary.disk.recordingBytes)} (${((primary.disk.recordingBytes / primary.disk.totalBytes) * 100).toFixed(1)}% tổng ổ)`
                        }
                      />
                      <InfoRow
                        label="Số ngày còn đủ"
                        value={
                          primary.disk.daysLeft === null
                            ? "chưa tính được"
                            : `${primary.disk.daysLeft} ngày`
                        }
                        tone={
                          primary.disk.daysLeft !== null && primary.disk.daysLeft < 3
                            ? "danger"
                            : primary.disk.daysLeft !== null && primary.disk.daysLeft < 7
                              ? "warn"
                              : "default"
                        }
                      />
                      <InfoRow
                        label="Ghi trung bình mỗi ngày"
                        value={
                          primary.disk.bytesPerDay
                            ? size(primary.disk.bytesPerDay)
                            : "chưa đủ số liệu"
                        }
                      />
                      <InfoRow
                        label="Thời gian lưu cài đặt"
                        value={
                          data.retentionDays != null ? `${data.retentionDays} ngày` : "chưa đặt"
                        }
                      />
                      <InfoRow
                        label="Dữ liệu hiện tại đủ"
                        value={
                          primary.disk.capacityDays === null
                            ? "chưa tính được"
                            : `${primary.disk.capacityDays} ngày`
                        }
                        tone={
                          data.retentionDays !== null &&
                          primary.disk.capacityDays !== null &&
                          primary.disk.capacityDays < data.retentionDays * 0.8
                            ? "warn"
                            : "default"
                        }
                      />
                    </dl>
                    <div className="px-4 pb-4">
                      <Link
                        href={CONFIG_HREF}
                        className="w-full h-11 rounded-xl border border-slate-200 bg-white text-slate-700 text-sm font-medium inline-flex items-center justify-center gap-2 hover:bg-slate-50"
                      >
                          <Settings className="h-4 w-4" />
                        Cấu hình lưu trữ
                      </Link>
                      {/* Nguồn số: máy kho đo ổ thật, không phải cộng từ sổ. */}
                      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                        Số liệu do chính máy kho đo trên ổ đĩa và gửi về.
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="p-4 text-sm text-slate-500">Chưa có số liệu ổ đĩa.</p>
                )}
              </section>
            </div>

            {/* ── Ghi theo ngày ──────────────────────────────────── */}
            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-100">
                <BarChart3 className="h-4 w-4 text-slate-500" />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-800">
                    Dung lượng ghi theo ngày
                  </h2>
                    <p className="text-xs text-slate-400">
                    Nhìn vào biểu đồ để biết vì sao ổ hết nhanh hay chậm.
                  </p>
                </div>
                <Select
                  value={windowDays}
                  onChange={setWindowDays}
                  options={WINDOW_OPTIONS}
                  size="sm"
                  ariaLabel="Khoảng ngày"
                  className="ml-auto w-44"
                />
              </div>

              {daily.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">Chưa có bản ghi nào trong khoảng này.</p>
              ) : (
                <>
                  <div className="px-4 pt-4 grid grid-cols-3 gap-3">
                    <MiniStat
                      icon={Video}
                      label="Số video đã ghi"
                      value={`${totalSegments}`}
                      tone={partialDays > 0 ? "warn" : "default"}
                    />
                    <MiniStat icon={Database} label="Tổng dung lượng" value={size(totalBytes)} />
                    <MiniStat
                      icon={CalendarDays}
                      label="Trung bình mỗi ngày"
                      value={size(Math.round(totalBytes / daily.length))}
                    />
                  </div>
                  {/* PHẢI nói rõ hai nguồn số: ô ổ đĩa ở trên do máy kho đo ổ
                      thật, còn ba ô này cộng từ sổ ghi hình — sổ GIỮ LẠI dòng
                      của video đã bị dọn (cố ý, để dựng lại được quá khứ), nên
                      cộng cả thời kỳ sẽ LỚN HƠN dung lượng ổ. Đo 02/10/2026:
                      sổ cộng 610 GB trong khi ổ 465 GB. Không nói ra thì người
                      đọc tưởng một trong hai con số sai. */}
                  <p className="mx-4 mt-1 text-[11px] leading-relaxed text-slate-400">
                    Số ở đây đếm video đã ghi trong khoảng đã chọn — gồm cả video sau đó đã bị dọn
                    theo hạn lưu. Dung lượng ổ đĩa ở phần trên mới là chỗ đang thật sự chiếm trên
                    máy kho.
                  </p>
                  <DailyChart rows={daily} max={maxDaily} />
                  {/* Ngày thiếu dung lượng phải nói ra: cột ngắn vì DB không
                      biết, KHÔNG phải vì kho ghi ít. Im lặng ở đây làm người
                      đọc kết luận ngược hẳn về nhịp ghi. */}
                  {partialDays > 0 && (
                    <p className="mx-4 mb-2 rounded-xl bg-amber-50 border border-amber-100 p-3 text-[11px] leading-relaxed text-amber-800 flex items-start gap-1.5">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
                      <span>
                        <strong>
                          {partialDays} ngày có video bị ghi trùng vào sổ (mỗi video hai dòng).
                        </strong>{" "}
                        Dòng thừa không mang kích thước nên cột của những ngày đó hiện{" "}
                        <strong>thấp hơn thực tế khoảng một nửa</strong>. Lỗi đã dừng từ khi máy
                        kho chuyển sang cách ghi mới.{" "}
                        <strong>Không video nào bị mất</strong> — số video thật của những ngày này
                        bằng khoảng một nửa con số hiển thị.{" "}
                        <span className="text-amber-700/80">
                          Không cần làm gì: các ngày này sẽ tự rời khỏi biểu đồ khi quá 14 ngày.
                        </span>
                      </span>
                    </p>
                  )}
                  {/* Đang quay KHÔNG phải cảnh báo — nói ở tông trung tính, và
                      chỉ nói khi thật sự có. Gán nhãn "máy kho bản cũ" cho mấy
                      đoạn này là cảnh báo sai mỗi ngày. */}
                  {recordingNow > 0 && (
                    <p className="mx-4 mb-4 text-[11px] leading-relaxed text-slate-500 flex items-start gap-1.5">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-px text-slate-400" />
                      <span>
                        {recordingNow} video đang quay ngay lúc này — quay xong mới biết nặng bao
                        nhiêu, vài phút nữa là có.
                      </span>
                    </p>
                  )}
                </>
              )}
            </section>

            {/* ── Clip trên máy chủ + gợi ý ──────────────────────── */}
            <div className="grid gap-4 lg:grid-cols-3">
              <section className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <Video className="h-4 w-4 text-slate-500" />
                  <h2 className="text-base font-semibold text-slate-800">Clip trên máy chủ</h2>
                </div>
                <div className="mt-3 flex flex-wrap items-start gap-10">
                  <div>
                    <p className="text-3xl font-semibold text-slate-800 tabular-nums">
                      {data.bucket.clips}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">clip đang sẵn sàng xem ngay</p>
                  </div>
                  <div>
                    <p className="text-3xl font-semibold text-slate-800 tabular-nums">
                      {size(data.bucket.bytes)}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">dung lượng trên máy chủ</p>
                  </div>
                </div>
                {/* Câu quan trọng nhất của mục này. Thiếu nó, người quản kho
                    thấy "72 giờ" rồi tưởng bằng chứng chỉ giữ được 3 ngày. */}
                <p className="mt-4 pt-3 border-t border-slate-100 text-xs leading-relaxed text-slate-600">
                  Clip đã xem được giữ sẵn trên máy chủ {data.bucket.ttlHours} giờ cho nhanh. Quá
                  hạn thì clip tự rời máy chủ — <strong>không mất bằng chứng</strong>: bản gốc vẫn
                  nằm ở ổ máy kho, và hệ tự dựng lại clip khi cần xem.
                </p>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-slate-500" />
                  <h2 className="text-base font-semibold text-slate-800">Hướng dẫn &amp; gợi ý</h2>
                </div>
                <ul className="mt-3 space-y-3">
                  <Tip
                    title="Kiểm tra dung lượng định kỳ"
                    body="Nên kiểm tra ít nhất 1 lần/ngày."
                  />
                  <Tip
                    title="Cân nhắc tăng dung lượng"
                    body={
                      data.retentionDays != null
                        ? `Để đảm bảo đủ lưu trữ ${data.retentionDays} ngày như đã cài đặt.`
                        : "Đặt số ngày lưu cho khớp sức chứa thật của ổ."
                    }
                  />
                  <Tip
                    title="Giảm số ngày lưu"
                    body="Nếu không nâng được ổ, hạ số ngày lưu cho khớp thực tế."
                  />
                </ul>
              </section>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

/* ---------------- Thành phần con ---------------- */

function WarningBanner({
  warning,
}: {
  warning: { kind: string; severity: "crit" | "warn"; message: string; action: string };
}) {
  const crit = warning.severity === "crit";
  // Retention mismatch links directly to the storage settings page.
  const isConfig = warning.kind === "retention_exceeds_capacity";
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 flex flex-wrap items-center gap-2.5 ${
        crit
          ? "border-red-200 bg-red-50/60"
          : "border-amber-200 bg-amber-50/55"
      }`}
    >
      <span
        className={`h-7 w-7 rounded-lg grid place-items-center shrink-0 ${
          crit ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"
        }`}
      >
        <AlertTriangle className="h-4 w-4" />
      </span>
      <p className="min-w-0 flex-1 text-xs leading-5 text-slate-700">
        <span className={`font-semibold ${crit ? "text-red-700" : "text-amber-800"}`}>
          {warning.message}
        </span>{" "}
        <span className="text-slate-400">· Cần làm:</span>{" "}
        <span>{warning.action}</span>
      </p>
      {isConfig && (
        <Link
          href={CONFIG_HREF}
          aria-label="Mở cấu hình lưu trữ"
          className="h-8 px-2.5 rounded-lg border border-amber-300 bg-white text-amber-800 text-xs font-medium inline-flex items-center gap-1 hover:bg-amber-50 shrink-0"
        >
          Cấu hình
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}

function DiskPanel({
  disk,
  retentionDays,
}: {
  disk: NonNullable<AgentDiskView["disk"]>;
  retentionDays: number | null;
}) {
  const usedPct = Math.min(100 - disk.freePct, 100);
  const recordingPct =
    disk.recordingBytes === null
      ? null
      : Math.min((disk.recordingBytes / disk.totalBytes) * 100, 100);
  const otherUsedBytes =
    disk.recordingBytes === null ? null : Math.max(disk.usedBytes - disk.recordingBytes, 0);
  const danger = disk.daysLeft !== null && disk.daysLeft < 3;
  const warn = !danger && disk.daysLeft !== null && disk.daysLeft < 7;
  const ring = danger ? "#ef4444" : warn ? "#f59e0b" : "#10b981";
  const mismatch =
    retentionDays !== null &&
    disk.capacityDays !== null &&
    disk.capacityDays < retentionDays * 0.8;

  return (
    <div className="p-5">
      <div className="flex flex-wrap items-center gap-6">
        {/* Vòng phần trăm — SVG thuần, không kéo thêm thư viện biểu đồ. */}
        <div className="relative h-36 w-36 shrink-0">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#e2e8f0" strokeWidth="14" />
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke={ring}
              strokeWidth="14"
              strokeLinecap="round"
              strokeDasharray={`${(usedPct / 100) * 2 * Math.PI * 52} ${2 * Math.PI * 52}`}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="text-2xl font-bold text-slate-800 tabular-nums">
                {usedPct.toFixed(1)}%
              </p>
              <p className="text-[11px] text-slate-500">Toàn ổ đã dùng</p>
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={`text-4xl font-bold tabular-nums ${
              danger ? "text-red-600" : warn ? "text-amber-600" : "text-slate-800"
            }`}
          >
            {disk.daysLeft === null ? "—" : `${disk.daysLeft} ngày`}
          </p>
          <p className="text-sm text-slate-500">nữa là đầy</p>

          <div className="mt-3 h-2.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${usedPct}%`, backgroundColor: ring }}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
            <span>
              Đã dùng {size(disk.usedBytes)} / {size(disk.totalBytes)}
            </span>
            <span>Còn trống {size(disk.freeBytes)}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-sky-100 bg-sky-50/50 p-3">
        <div className="flex items-center gap-3">
          <span className="h-9 w-9 rounded-lg bg-white text-sky-600 grid place-items-center border border-sky-100 shrink-0">
            <Video className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-800">Thư mục lưu video</p>
            <p className="text-[11px] text-slate-500">
              Đo riêng toàn bộ dữ liệu trong thư mục máy kho dùng để lưu video, tối đa chậm khoảng 1 giờ.
            </p>
          </div>
          <p className="text-lg font-bold text-sky-700 tabular-nums shrink-0">
            {disk.recordingBytes === null ? "—" : size(disk.recordingBytes)}
          </p>
        </div>

        {recordingPct === null ? (
          <p className="mt-2 text-[11px] leading-relaxed text-amber-700">
            Máy kho hiện mới báo tổng ổ, chưa báo riêng dung lượng thư mục video. Cần cập
            nhật agent để có số này.
          </p>
        ) : (
          <>
            <div className="mt-3 h-2 rounded-full bg-white overflow-hidden border border-sky-100">
              <div
                className="h-full rounded-full bg-sky-500"
                style={{ width: `${recordingPct}%` }}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px] text-slate-500">
              <span>Video chiếm {recordingPct.toFixed(1)}% tổng ổ</span>
              <span>Dữ liệu khác trên ổ {size(otherUsedBytes ?? 0)}</span>
            </div>
          </>
        )}
      </div>
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-slate-100">
        <MiniStat
          icon={Database}
          label="Dung lượng mỗi ngày"
          value={disk.bytesPerDay ? size(disk.bytesPerDay) : "chưa đủ"}
        />
        <MiniStat
          icon={CalendarDays}
          label="Dữ liệu hiện tại đủ"
          value={disk.capacityDays === null ? "chưa tính" : `${disk.capacityDays} ngày`}
          tone={mismatch ? "warn" : "default"}
        />
        <MiniStat
          icon={Settings}
          label="Đang cài đặt giữ"
          value={retentionDays != null ? `${retentionDays} ngày` : "chưa đặt"}
        />
      </div>

      {mismatch && (
        <p className="mt-3 rounded-xl bg-amber-50 border border-amber-100 p-3 text-xs leading-relaxed text-amber-800 flex items-start gap-1.5">
          <Info className="h-4 w-4 shrink-0 mt-px" />
          <span>
            Đặt {retentionDays} ngày nhưng ổ chỉ đủ khoảng {disk.capacityDays} ngày — bản ghi có
            thể bị dọn sớm hơn số ngày đã đặt.
          </span>
        </p>
      )}
    </div>
  );
}

function DailyChart({ rows, max }: { rows: DailyRow[]; max: number }) {
  // Cũ → mới từ trái sang phải, như mọi biểu đồ thời gian.
  const ordered = [...rows].reverse();
  // Trục dọc làm tròn lên bội số 10 GB để nhãn đọc được, và để cột cao nhất
  // không chạm nóc khung.
  const step = 10 * 1024 ** 3;
  const top = Math.max(Math.ceil(max / step) * step, step);
  const ticks = [1, 0.75, 0.5, 0.25, 0];

  return (
    <div className="p-4">
      <div className="flex gap-2">
        {/* Nhãn trục dọc */}
        <div className="w-12 shrink-0 h-48 relative">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-slate-400 tabular-nums"
              style={{ top: `${(1 - t) * 100}%` }}
            >
              {Math.round((top * t) / 1024 ** 3)} GB
            </span>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {/* h-48 CỐ ĐỊNH ở đây, và cột con dùng % của chính nó. Bản trước
              lồng flex-1 bên trong flex-col nên chiều cao % không có mốc để
              quy chiếu — mọi cột ra 0px, biểu đồ trống trơn. */}
          <div className="relative h-48 border-b border-slate-200">
            {/* Lưới ngang */}
            {ticks.slice(0, -1).map((t) => (
              <div
                key={t}
                className="absolute inset-x-0 border-t border-dashed border-slate-100"
                style={{ top: `${(1 - t) * 100}%` }}
              />
            ))}
            <div className="absolute inset-0 flex items-end gap-1.5">
              {ordered.map((d) => {
                const pct = top > 0 ? (d.bytes / top) * 100 : 0;
                const partial = d.segmentsWithoutSize > 0;
                return (
                  <div
                    key={d.day}
                    className={`flex-1 min-w-0 rounded-t-md transition-colors ${
                      partial ? "bg-amber-300 hover:bg-amber-400" : "bg-emerald-400 hover:bg-emerald-500"
                    }`}
                    // Tối thiểu 2% để ngày có ghi nhưng rất ít vẫn thấy được
                    // một vạch — 0px trông giống hệt ngày không ghi gì.
                    style={{ height: `${Math.max(pct, 2)}%` }}
                    title={
                      `${d.day}: ${size(d.bytes)} · ${d.segments - d.segmentsWithoutSize} video` +
                      (partial
                        ? ` (sổ ghi thành ${d.segments} dòng — mỗi video hai dòng, video không bị mất)`
                        : "") +
                      (d.segmentsRecording > 0 ? ` · ${d.segmentsRecording} video đang quay` : "")
                    }
                  />
                );
              })}
            </div>
          </div>

          {/* Nhãn ngày — cùng flex với cột để thẳng hàng tuyệt đối. */}
          <div className="flex gap-1.5 mt-1.5">
            {ordered.map((d) => (
              <span
                key={d.day}
                className="flex-1 min-w-0 text-center text-[10px] text-slate-400 tabular-nums"
              >
                {d.day.slice(8)}/{d.day.slice(5, 7)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: typeof Database;
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3 flex items-center gap-2.5">
      <Icon className="h-4 w-4 text-slate-400 shrink-0" />
      <div className="min-w-0">
        <p className="text-[11px] text-slate-500 truncate">{label}</p>
        <p
          className={`text-sm font-semibold tabular-nums ${
            tone === "warn" ? "text-amber-700" : "text-slate-800"
          }`}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  tone = "default",
  mono = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "warn" | "danger";
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500 text-xs">{label}</dt>
      <dd
        className={`text-xs font-medium text-right ${mono ? "font-mono" : ""} ${
          tone === "danger"
            ? "text-red-600"
            : tone === "warn"
              ? "text-amber-700"
              : "text-slate-800"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Tip({ title, body }: { title: string; body: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="h-5 w-5 rounded-full bg-emerald-50 text-emerald-600 grid place-items-center shrink-0 mt-px">
        <Check className="h-3 w-3" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-800">{title}</p>
        <p className="text-[11px] text-slate-500 leading-relaxed">{body}</p>
      </div>
    </li>
  );
}
