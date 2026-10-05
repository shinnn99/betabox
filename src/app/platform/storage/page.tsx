"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Database,
  HardDrive,
  HelpCircle,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import Select from "@/components/ui/Select";
import { ago, formatVn } from "@/lib/format/time-vn";

/**
 * Dung lượng video trên Supabase Storage.
 *
 * ══ CÂU PHẢI NÓI TO NHẤT Ở TRANG NÀY ══
 *
 * Bucket này là CACHE 72 GIỜ, không phải nơi lưu bằng chứng 30 ngày. Nguồn
 * chân lý là segment thô dưới máy kho, giữ theo `retention_days`. Clip hết
 * 72h bị dọn khỏi bucket (`status='evicted'`) nhưng xem lại vẫn được — /watch
 * tự cắt lại từ segment gốc.
 *
 * Nên cột "còn lại" ở đây tính bằng GIỜ, và trang phải nhắc đi nhắc lại rằng
 * hết giờ KHÔNG phải mất bằng chứng. Thiếu câu đó, người đọc sẽ thấy "còn 2
 * giờ" rồi tưởng sắp mất video của khách.
 *
 * ══ VÌ SAO KHÔNG CÓ Ô TIỀN ══
 *
 * Chủ dự án chốt 02/10/2026: không hiện con số tiền nào. Hạn mức gói và đơn
 * giá vượt trần chỉ tồn tại ở trang billing Supabase, không có API công khai
 * (đã kiểm 12/08/2026 — xem `checkEgress` trong lib/system/checks.ts). Một ô
 * tiền gõ tay sẽ lỗi thời âm thầm ngay lần Supabase đổi giá, mà người đọc vẫn
 * tin. Trang này trả lời "đang dùng bao nhiêu, của kho nào, file nào nặng" —
 * còn tiền thì mở dashboard Supabase.
 */

interface StorageObjectRow {
  path: string;
  sizeBytes: number;
  createdAt: string;
  orgId: string | null;
  orgName: string | null;
  waybillCode: string | null;
  hoursLeft: number;
}

interface OrgStorageRow {
  orgId: string | null;
  orgName: string;
  objects: number;
  bytes: number;
  overdueObjects: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

type UsageView =
  | {
      available: true;
      bucket: string;
      ttlHours: number;
      totalObjects: number;
      totalBytes: number;
      accountedBytes: number;
      orphanObjects: number;
      orphanBytes: number;
      overdueObjects: number;
      orgs: OrgStorageRow[];
      objects: StorageObjectRow[];
      truncated: boolean;
    }
  | { available: false; reason: string };

interface StorageResponse {
  usage: UsageView;
  last_cleanup: { at: string; ok: boolean; deleted: number | null } | null;
}

/** Lượt dọn chạy theo cron; quá ngần này là coi như đã ngừng. */
const STALE_CLEANUP_MS = 26 * 3600_000;

function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Giờ còn lại → chữ. Âm nghĩa là quá hạn mà lượt dọn chưa đụng tới. */
function leftLabel(hoursLeft: number): { text: string; tone: string } {
  if (hoursLeft < 0) {
    return { text: `quá hạn ${Math.abs(hoursLeft).toFixed(1)} giờ`, tone: "text-red-600 font-medium" };
  }
  if (hoursLeft < 6) return { text: `còn ${hoursLeft.toFixed(1)} giờ`, tone: "text-amber-700" };
  return { text: `còn ${hoursLeft.toFixed(1)} giờ`, tone: "text-slate-600" };
}

export default function PlatformStoragePage() {
  const [data, setData] = useState<StorageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [orgFilter, setOrgFilter] = useState("all");

  // KHÔNG setLoading(true) ở đầu: lượt đầu do effect gọi mà `loading` đã khởi
  // tạo true (react-hooks/set-state-in-effect). Nút tự bật spinner.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/platform/storage", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? json.error ?? "Không tải được dung lượng video.");
        setData(null);
      } else {
        setData(json as StorageResponse);
        setError("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi mạng.");
      setData(null);
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const usage = data?.usage;
  const ok = usage?.available ? usage : null;

  const objects = useMemo(() => {
    if (!ok) return [];
    const q = query.trim().toLowerCase();
    return ok.objects.filter((o) => {
      if (orgFilter !== "all") {
        if (orgFilter === "__orphan__" ? o.orgId !== null : o.orgId !== orgFilter) return false;
      }
      if (!q) return true;
      return (
        o.path.toLowerCase().includes(q) ||
        (o.waybillCode ?? "").toLowerCase().includes(q) ||
        (o.orgName ?? "").toLowerCase().includes(q)
      );
    });
  }, [ok, query, orgFilter]);

  const cleanupStale =
    data?.last_cleanup != null && now - Date.parse(data.last_cleanup.at) > STALE_CLEANUP_MS;

  return (
    <PlatformLayout
      pageTitle="Dung lượng video"
      pageSubtitle="Video đang nằm trên Supabase Storage — bucket là bộ nhớ đệm, không phải kho lưu bằng chứng."
      pageIcon={HardDrive}
    >
      <div className="space-y-5">
        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !usage ? null : !usage.available ? (
          // Chưa đo được thì nói CHƯA ĐO ĐƯỢC. Hiện "0 byte" ở đây đọc y hệt
          // một bucket rỗng, và đó là kết luận sai.
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 flex items-start gap-2">
            <HelpCircle className="h-4 w-4 shrink-0 mt-0.5 text-slate-400" />
            <span>{usage.reason}</span>
          </div>
        ) : (
          <>
            {/* ── Câu nhắc về bản chất bucket ─────────────────────── */}
            <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 flex items-start gap-3">
              <Database className="h-5 w-5 text-sky-600 shrink-0 mt-0.5" />
              <div className="text-sm text-slate-700">
                <p className="font-medium text-slate-800">
                  Bucket <span className="font-mono text-xs">{usage.bucket}</span> là bộ nhớ đệm{" "}
                  {usage.ttlHours} giờ, không phải nơi lưu bằng chứng.
                </p>
                <p className="mt-0.5 text-slate-600">
                  Hết {usage.ttlHours} giờ, lượt dọn xoá file khỏi bucket — nhưng{" "}
                  <strong>không mất bằng chứng</strong>: bản gốc vẫn nằm dưới máy kho theo hạn lưu
                  của từng tổ chức, và trang xem clip tự cắt lại khi cần. Con số dưới đây là thứ
                  Supabase đang tính tiền lưu trữ, không phải toàn bộ video của khách.
                </p>
              </div>
            </div>

            {/* ── Bốn ô số ────────────────────────────────────────── */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                icon={HardDrive}
                label="Tổng dung lượng"
                value={mb(usage.totalBytes)}
                hint={`${usage.totalObjects} file trên bucket`}
                tone="slate"
              />
              <StatCard
                icon={Clock}
                label="Quá hạn chưa dọn"
                value={String(usage.overdueObjects)}
                hint={
                  usage.overdueObjects === 0
                    ? "Lượt dọn đang theo kịp"
                    : `Quá ${usage.ttlHours} giờ mà còn trên bucket`
                }
                tone={usage.overdueObjects === 0 ? "ok" : "warn"}
              />
              <StatCard
                icon={AlertTriangle}
                label="File không rõ chủ"
                value={String(usage.orphanObjects)}
                hint={
                  usage.orphanObjects === 0
                    ? "Mọi file đều gắn được với một đơn"
                    : `${mb(usage.orphanBytes)} không dòng clip nào nhận`
                }
                tone={usage.orphanObjects === 0 ? "ok" : "warn"}
              />
              <StatCard
                icon={Trash2}
                label="Lượt dọn gần nhất"
                value={data?.last_cleanup ? ago(data.last_cleanup.at, now) : "chưa bao giờ"}
                hint={
                  !data?.last_cleanup
                    ? "Chưa có dòng nào trong sổ job"
                    : cleanupStale
                      ? "Quá lâu — lượt dọn có thể đã chết"
                      : `${data.last_cleanup.deleted ?? 0} file được xoá lượt đó`
                }
                tone={!data?.last_cleanup || cleanupStale ? "warn" : "ok"}
              />
            </div>

            {usage.truncated && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-800">
                Bucket có nhiều file hơn mức trang đọc về một lượt — tổng ở trên là phần đã đọc,
                KHÔNG phải toàn bộ. Thường là dấu hiệu lượt dọn đã ngừng nhiều ngày.
              </div>
            )}

            {/* ── Theo kho ────────────────────────────────────────── */}
            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-100">
                <h2 className="text-base font-semibold text-slate-800">Theo kho</h2>
                <span className="h-6 px-2 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-semibold inline-flex items-center">
                  {usage.orgs.length} nhóm
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    void load();
                  }}
                  disabled={loading}
                  className="ml-auto h-9 px-4 rounded-xl border border-slate-200 bg-white text-slate-600 text-sm font-medium inline-flex items-center gap-2 hover:bg-slate-50 disabled:opacity-60"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Kiểm lại
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[46rem]">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                      <th className="font-medium px-4 py-2.5">Kho</th>
                      <th className="font-medium px-4 py-2.5 text-right">Số video</th>
                      <th className="font-medium px-4 py-2.5 text-right">Dung lượng</th>
                      <th className="font-medium px-4 py-2.5 text-right">Phần trăm</th>
                      <th className="font-medium px-4 py-2.5 text-right">Quá hạn</th>
                      <th className="font-medium px-4 py-2.5">File cũ nhất</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.orgs.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                          Bucket đang trống — không có video nào trên Storage.
                        </td>
                      </tr>
                    ) : (
                      usage.orgs.map((o) => (
                        <tr key={o.orgId ?? "__orphan__"} className="border-b border-slate-50 last:border-0">
                          <td className="px-4 py-3">
                            {o.orgId ? (
                              <span className="font-medium text-slate-800">{o.orgName}</span>
                            ) : (
                              <span className="text-amber-700 font-medium" title="Không dòng clip nào trỏ tới các file này">
                                {o.orgName}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                            {o.objects}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-800 font-medium">
                            {mb(o.bytes)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                            {usage.totalBytes > 0
                              ? `${Math.round((o.bytes / usage.totalBytes) * 1000) / 10}%`
                              : "—"}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {o.overdueObjects === 0 ? (
                              <span className="text-slate-400">0</span>
                            ) : (
                              <span className="text-red-600 font-medium">{o.overdueObjects}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">
                            {o.oldestCreatedAt ? formatVn(o.oldestCreatedAt) : "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {usage.orphanObjects > 0 && (
                <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-100">
                  {usage.orphanObjects} file ({mb(usage.orphanBytes)}) không gắn được với đơn nào —
                  vẫn tính tiền lưu trữ nhưng lượt dọn theo hạn clip không chạm tới, vì nó đi từ
                  bảng clip chứ không đi từ bucket.
                </p>
              )}
            </section>

            {/* ── Từng video ──────────────────────────────────────── */}
            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-100">
                <h2 className="text-base font-semibold text-slate-800">Từng video</h2>
                <span className="h-6 px-2 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-semibold inline-flex items-center">
                  nặng nhất trước
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Tìm mã đơn, đường dẫn…"
                      className="h-9 pl-9 pr-3 w-56 rounded-xl border border-slate-200 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                    />
                  </div>
                  <Select
                    value={orgFilter}
                    onChange={setOrgFilter}
                    options={[
                      { value: "all", label: "Tất cả kho" },
                      ...usage.orgs
                        .filter((o) => o.orgId !== null)
                        .map((o) => ({ value: o.orgId as string, label: o.orgName })),
                      ...(usage.orphanObjects > 0
                        ? [{ value: "__orphan__", label: "Không rõ chủ" }]
                        : []),
                    ]}
                    size="sm"
                    ariaLabel="Lọc theo kho"
                    className="w-48"
                  />
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[52rem]">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                      <th className="font-medium px-4 py-2.5">Đơn / đường dẫn</th>
                      <th className="font-medium px-4 py-2.5">Kho</th>
                      <th className="font-medium px-4 py-2.5 text-right">Dung lượng</th>
                      <th className="font-medium px-4 py-2.5">Lên bucket</th>
                      <th className="font-medium px-4 py-2.5">Còn lại trên bucket</th>
                    </tr>
                  </thead>
                  <tbody>
                    {objects.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                          {usage.totalObjects === 0
                            ? "Bucket đang trống."
                            : "Không file nào khớp bộ lọc."}
                        </td>
                      </tr>
                    ) : (
                      objects.map((o) => {
                        const left = leftLabel(o.hoursLeft);
                        return (
                          <tr key={o.path} className="border-b border-slate-50 last:border-0">
                            <td className="px-4 py-3">
                              {o.waybillCode ? (
                                <span className="font-medium text-slate-800">{o.waybillCode}</span>
                              ) : (
                                <span className="text-amber-700">không gắn đơn</span>
                              )}
                              <div className="text-[11px] text-slate-400 break-all font-mono">
                                {o.path}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-600">
                              {o.orgName ?? <span className="text-amber-700">không rõ</span>}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-slate-800">
                              {mb(o.sizeBytes)}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                              {formatVn(o.createdAt)}
                            </td>
                            <td className={`px-4 py-3 text-xs whitespace-nowrap ${left.tone}`}>
                              {left.text}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-100">
                Hiển thị {objects.length} trong {usage.totalObjects} file. Cột &ldquo;còn lại&rdquo;
                đếm tới lượt dọn bucket — hết giờ KHÔNG mất bằng chứng, bản gốc vẫn ở máy kho.
              </p>
            </section>

            {/* ── Phần tiền ───────────────────────────────────────── */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="text-base font-semibold text-slate-800">Chi phí lưu trữ</h2>
              <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                Trang này cố ý KHÔNG hiện con số tiền. Hạn mức gói và đơn giá vượt trần chỉ có ở
                trang billing của Supabase — không có API công khai nào trả về (đã kiểm Management
                API và endpoint Prometheus ngày 12/08/2026). Một con số tiền gõ tay vào đây sẽ lỗi
                thời ngay lần Supabase đổi giá, mà người đọc vẫn tin.
              </p>
              <p className="mt-2 text-sm text-slate-600">
                Dùng con số <strong>{mb(usage.totalBytes)}</strong> ở trên để đối chiếu với mục
                Storage trong dashboard Supabase.
              </p>
            </div>
          </>
        )}
      </div>
    </PlatformLayout>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
  hint: string;
  tone: "ok" | "warn" | "slate";
}) {
  const toneClass =
    tone === "ok"
      ? { soft: "bg-emerald-50 text-emerald-600", text: "text-emerald-600" }
      : tone === "warn"
        ? { soft: "bg-amber-50 text-amber-600", text: "text-amber-700" }
        : { soft: "bg-slate-100 text-slate-500", text: "text-slate-500" };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className={`h-10 w-10 rounded-xl grid place-items-center shrink-0 ${toneClass.soft}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-0.5 text-2xl font-semibold text-slate-800">{value}</p>
        </div>
      </div>
      <p className={`mt-2 text-xs ${toneClass.text}`}>{hint}</p>
    </div>
  );
}
