"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Bell,
  Loader2,
  RefreshCcw,
  Search,
  Layers,
  CheckCircle2,
  Pause,
  Settings,
  Pencil,
  Eye,
  EyeOff,
  Send,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Warehouse as WarehouseIcon,
  X,
  Save,
  Trash2,
  Lock,
  Copy,
  Check,
  MessageSquare,
  HelpCircle,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";

const LARK_WEBHOOK_PREFIX = "https://open.larksuite.com/open-apis/bot/v2/hook/";

interface LastNotification {
  event_type: string;
  waybill_code: string | null;
  sent_at: string;
}

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  status: string;
  notify_lark_webhook_url: string | null;
  notify_lark_enabled: boolean;
  notify_lark_last_test_at: string | null;
  notify_lark_digest_daily: boolean;
  notify_lark_digest_weekly: boolean;
  notify_lark_digest_monthly: boolean;
  has_recent_failure: boolean;
  last_notification: LastNotification | null;
}

type FilterStatus = "all" | "on" | "off" | "missing" | "error";
type SortMode = "code_asc" | "code_desc" | "name_asc" | "name_desc";

const EVENT_LABEL: Record<string, string> = {
  packing_issue_duplicated: "Đơn quét trùng",
  packing_issue_no_active_session: "Quét không có ca mở",
  packing_issue_unmapped_scanner: "Máy quét chưa gán",
  packing_issue_invalid_code: "Mã quét lỗi",
};

export default function NotificationsSettingsPage() {
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [sortMode, setSortMode] = useState<SortMode>("code_asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<WarehouseRow | null>(null);
  // Giữ warehouse cuối để panel giữ nội dung khi đóng (animation).
  const [lastEdited, setLastEdited] = useState<WarehouseRow | null>(null);
  useEffect(() => {
    if (editing) setLastEdited(editing);
  }, [editing]);
  const [showHelp, setShowHelp] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/warehouses/notifications-overview", {
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được danh sách kho.");
      setLoading(false);
      return;
    }
    setWarehouses(data.warehouses ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Derived state.
  const totals = useMemo(() => {
    const on = warehouses.filter((w) => !!w.notify_lark_webhook_url && w.notify_lark_enabled).length;
    const off = warehouses.filter((w) => !!w.notify_lark_webhook_url && !w.notify_lark_enabled).length;
    const missing = warehouses.filter((w) => !w.notify_lark_webhook_url).length;
    return { total: warehouses.length, on, off, missing };
  }, [warehouses]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = warehouses.filter((w) => {
      if (q && !w.name.toLowerCase().includes(q) && !w.code.toLowerCase().includes(q)) return false;
      if (filterStatus === "all") return true;
      const state = deriveState(w);
      return state === filterStatus;
    });
    rows = [...rows].sort((a, b) => {
      if (sortMode === "code_asc") return a.code.localeCompare(b.code);
      if (sortMode === "code_desc") return b.code.localeCompare(a.code);
      if (sortMode === "name_asc") return a.name.localeCompare(b.name);
      return b.name.localeCompare(a.name);
    });
    return rows;
  }, [warehouses, search, filterStatus, sortMode]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Reset page về 1 khi đổi filter/search.
  useEffect(() => setPage(1), [search, filterStatus, sortMode, pageSize]);

  return (
    <DashboardLayout
      pageTitle="Cấu hình thông báo"
      pageSubtitle="Cảnh báo đơn lỗi qua Lark cho quản lý kho"
      pageIcon={Bell}
    >
      {/* h-full flex + panel fixed height 100% = luôn khớp viewport <main>,
          không tạo scroll dọc thừa trên page. Nội dung bảng tự scroll trong
          div riêng khi vượt chiều cao. */}
      <div className="flex gap-4 items-stretch h-full">
        {/* Main content — co lại khi mở side panel, transition mượt qua width.
            overflow-y-auto để bảng dài tự scroll bên trong, không đẩy trang. */}
        <div
          className="min-w-0 transition-[width] duration-300 ease-out overflow-y-auto overflow-x-hidden pr-1"
          style={{ width: editing ? "calc(100% - 396px)" : "100%" }}
        >
        <div className="space-y-4">
        {/* Stat cards — 4 cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            variant="all"
            icon={<Layers className="h-5 w-5" />}
            label="Tất cả"
            value={totals.total}
            hint="Kho"
          />
          <StatCard
            variant="on"
            icon={<CheckCircle2 className="h-5 w-5" />}
            label="Đang bật"
            value={totals.on}
            hint="Kho"
          />
          <StatCard
            variant="off"
            icon={<Pause className="h-5 w-5" />}
            label="Đã tắt"
            value={totals.off}
            hint="Kho"
          />
          <StatCard
            variant="missing"
            icon={<Settings className="h-5 w-5" />}
            label="Chưa cấu hình"
            value={totals.missing}
            hint="Kho"
          />
        </div>

        {/* Toolbar */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
          <div className="p-3 flex flex-col md:flex-row gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm tên hoặc mã kho"
                className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-emerald-400"
              />
            </div>
            <div className="w-full md:w-52">
              <Select
                value={filterStatus}
                onChange={(v) => setFilterStatus(v as FilterStatus)}
                options={[
                  { value: "all", label: "Trạng thái: Tất cả" },
                  { value: "on", label: "Trạng thái: Đang bật" },
                  { value: "off", label: "Trạng thái: Đã tắt" },
                  { value: "missing", label: "Trạng thái: Chưa cấu hình" },
                  { value: "error", label: "Trạng thái: Lỗi webhook" },
                ]}
              />
            </div>
            <div className="w-full md:w-52">
              <Select
                value={sortMode}
                onChange={(v) => setSortMode(v as SortMode)}
                options={[
                  { value: "code_asc", label: "Sắp xếp: Mã A → Z" },
                  { value: "code_desc", label: "Sắp xếp: Mã Z → A" },
                  { value: "name_asc", label: "Sắp xếp: Tên A → Z" },
                  { value: "name_desc", label: "Sắp xếp: Tên Z → A" },
                ]}
              />
            </div>
            <button
              onClick={() => setShowHelp(true)}
              className="h-10 px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm inline-flex items-center gap-2 text-slate-700"
            >
              <HelpCircle className="h-4 w-4" />
              Hướng dẫn
            </button>
            <button
              onClick={load}
              disabled={loading}
              className="h-10 px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm inline-flex items-center gap-2 disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Làm mới
            </button>
          </div>
        </div>

        {/* Bảng — scroll ngang khi panel mở nếu cần. Header cells whitespace-nowrap
             để không wrap thành nhiều dòng khi co. */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100 rounded-t-2xl">
              {error}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[880px]">
              <thead className="bg-slate-50/60 rounded-t-2xl">
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Kho</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Trạng thái</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Webhook</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Kiểm tra gần nhất</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Thông báo gần nhất</th>
                  <th className="px-4 py-3 font-medium text-right whitespace-nowrap">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {loading && warehouses.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400 text-sm">
                      {warehouses.length === 0 ? (
                        <>Chưa có kho nào. Tạo kho trong{" "}
                          <a href="/dashboard/warehouses" className="text-emerald-600 hover:underline">
                            Tổ chức &amp; Kho
                          </a>{" "}
                          trước.</>
                      ) : (
                        "Không tìm thấy kho phù hợp với bộ lọc."
                      )}
                    </td>
                  </tr>
                )}
                {paged.map((w) => (
                  <WarehouseRowView
                    key={w.id}
                    warehouse={w}
                    isEditing={editing?.id === w.id}
                    onEdit={() => setEditing(w)}
                    onChanged={load}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {filtered.length > 0 && (
            <div className="p-3 border-t border-slate-100 flex flex-col md:flex-row items-center gap-3">
              <p className="text-xs text-slate-500 md:mr-auto">
                Hiển thị {(currentPage - 1) * pageSize + 1} – {Math.min(currentPage * pageSize, filtered.length)} trong {filtered.length} kho
              </p>
              <Pagination
                page={currentPage}
                totalPages={totalPages}
                onChange={setPage}
              />
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>Hiển thị</span>
                <div className="w-20">
                  <Select
                    value={String(pageSize)}
                    onChange={(v) => setPageSize(Number(v))}
                    options={[
                      { value: "10", label: "10" },
                      { value: "20", label: "20" },
                      { value: "50", label: "50" },
                    ]}
                  />
                </div>
                <span>/ trang</span>
              </div>
            </div>
          )}
        </div>
        </div>
        </div>

        {/* Side panel — LUÔN render để animate transform vào/ra. Khi editing=null
             thì trượt hết ra phải + width 0 (không chiếm chỗ). Giữ warehouse
             cuối cùng để nội dung không nhảy khi đóng. */}
        <SidePanelWrapper
          open={!!editing}
          warehouse={editing ?? lastEdited}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onReload={load}
        />
      </div>

      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
    </DashboardLayout>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-slate-500" />
            <h3 className="font-semibold text-slate-800">Hướng dẫn cấu hình Lark</h3>
          </div>
          <button onClick={onClose} className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 inline-flex items-center justify-center">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto space-y-3 text-sm text-slate-600">
          <div>
            <h4 className="font-semibold text-slate-800 mb-1">Bước 1 — Tạo Custom Bot trong nhóm Lark</h4>
            <ol className="list-decimal ml-5 space-y-1">
              <li>Mở nhóm Lark quản lý kho.</li>
              <li>Bấm ⚙️ Settings → <strong>Group Bots</strong> hoặc <strong>Add-ons → Bots</strong>.</li>
              <li>Bấm <strong>Add Bot</strong> → chọn <strong>Custom Bot</strong>.</li>
              <li>Đặt tên (VD: <em>Betacom Cảnh báo đơn lỗi</em>).</li>
              <li>Không bật "Signed request" / "IP whitelist".</li>
            </ol>
          </div>
          <div>
            <h4 className="font-semibold text-slate-800 mb-1">Bước 2 — Dán webhook vào kho</h4>
            <ol className="list-decimal ml-5 space-y-1">
              <li>Copy webhook URL — dạng <code className="text-xs bg-slate-100 px-1 rounded">{LARK_WEBHOOK_PREFIX}&lt;token&gt;</code></li>
              <li>Bấm icon ✏️ Sửa của kho tương ứng.</li>
              <li>Dán URL vào ô "Webhook Lark".</li>
              <li>Bật toggle "Trạng thái" → bấm <strong>Lưu thay đổi</strong>.</li>
            </ol>
          </div>
          <div>
            <h4 className="font-semibold text-slate-800 mb-1">Bước 3 — Test kết nối</h4>
            <p>Sau khi lưu, bấm <strong>Kiểm tra</strong> để gửi tin test → mở nhóm Lark xem tin đã tới chưa.</p>
          </div>
          <div className="text-xs text-slate-500 pt-2 border-t border-slate-100">
            Chỉ chấp nhận host <code className="bg-slate-100 px-1 rounded">open.larksuite.com</code>. Feishu (open.feishu.cn) không được hỗ trợ.
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function deriveState(w: WarehouseRow): "on" | "off" | "missing" | "error" {
  if (!w.notify_lark_webhook_url) return "missing";
  if (w.has_recent_failure && w.notify_lark_enabled) return "error";
  if (!w.notify_lark_enabled) return "off";
  return "on";
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  return `${hh}:${mm}, ${day}/${month}/${year}`;
}

function maskWebhook(url: string | null): string {
  if (!url) return "—";
  const token = url.startsWith(LARK_WEBHOOK_PREFIX)
    ? url.slice(LARK_WEBHOOK_PREFIX.length)
    : url;
  return "•".repeat(Math.min(20, Math.max(8, token.length - 4))) + token.slice(-4);
}

// ============================================================================
// Sub-components
// ============================================================================

function StatCard({
  variant,
  icon,
  label,
  value,
  hint,
}: {
  variant: "all" | "on" | "off" | "missing";
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
}) {
  const style = {
    all: { iconBg: "bg-sky-50 text-sky-600", valueColor: "text-slate-800" },
    on: { iconBg: "bg-emerald-50 text-emerald-600", valueColor: "text-slate-800" },
    off: { iconBg: "bg-amber-50 text-amber-600", valueColor: "text-slate-800" },
    missing: { iconBg: "bg-slate-100 text-slate-500", valueColor: "text-slate-800" },
  }[variant];
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-center gap-3">
        <div className={`h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${style.iconBg}`}>
          {icon}
        </div>
        <div>
          <div className="text-xs font-medium text-slate-500">{label}</div>
          <div className={`text-2xl font-semibold leading-tight ${style.valueColor}`}>{value}</div>
          <div className="text-xs text-slate-400">{hint}</div>
        </div>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: "on" | "off" | "missing" | "error" }) {
  if (state === "on") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
        Đang bật
      </span>
    );
  }
  if (state === "off") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium">
        Đã tắt
      </span>
    );
  }
  if (state === "missing") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs font-medium">
        Chưa cấu hình
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 text-xs font-medium">
      Lỗi webhook
    </span>
  );
}

function WarehouseRowView({
  warehouse,
  isEditing,
  onEdit,
  onChanged,
}: {
  warehouse: WarehouseRow;
  isEditing: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const state = deriveState(warehouse);
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const runTest = async () => {
    setTesting(true);
    try {
      const res = await fetch(`/api/warehouses/${warehouse.id}/test-lark`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast.error(data.message ?? "Test webhook thất bại");
      } else {
        toast.success("Đã gửi tin test tới nhóm Lark của " + warehouse.name);
      }
    } catch (err) {
      toast.error("Lỗi mạng: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setTesting(false);
      onChanged();
    }
  };

  const clearConfig = async () => {
    const ok = await confirm({
      title: "Xoá cấu hình Lark?",
      message: `Kho "${warehouse.name}" sẽ không nhận thông báo Lark nữa. Bạn có thể dán webhook lại bất kỳ lúc nào.`,
      confirmLabel: "Xoá cấu hình",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/warehouses/${warehouse.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notify_lark_webhook_url: null, notify_lark_enabled: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message ?? "Không xoá được cấu hình");
        return;
      }
      toast.success("Đã xoá cấu hình Lark của " + warehouse.name);
    } finally {
      onChanged();
    }
  };

  const bgHighlight = isEditing
    ? "bg-emerald-50/60 ring-1 ring-inset ring-emerald-200"
    : state === "on"
      ? "bg-emerald-50/30"
      : state === "error"
        ? "bg-rose-50/30"
        : "";

  return (
    <tr className={`border-t border-slate-100 hover:bg-slate-50/40 transition-colors ${bgHighlight}`}>
      {/* Kho */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
            <WarehouseIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-slate-800 truncate">{warehouse.name}</p>
            <p className="text-[11px] text-slate-500 font-mono">{warehouse.code}</p>
          </div>
        </div>
      </td>

      {/* Trạng thái */}
      <td className="px-4 py-3">
        <StateBadge state={state} />
      </td>

      {/* Webhook */}
      <td className="px-4 py-3">
        {warehouse.notify_lark_webhook_url ? (
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${state === "error" ? "bg-rose-500" : "bg-emerald-500"}`} />
            <span className="font-mono text-xs text-slate-700">
              {revealed
                ? warehouse.notify_lark_webhook_url.slice(0, 35) + "..."
                : maskWebhook(warehouse.notify_lark_webhook_url)}
            </span>
            <button
              onClick={() => setRevealed((v) => !v)}
              className="text-slate-400 hover:text-slate-600"
              title={revealed ? "Ẩn" : "Hiện"}
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        ) : (
          <span className="text-slate-400 text-xs">—</span>
        )}
      </td>

      {/* Kiểm tra gần nhất */}
      <td className="px-4 py-3">
        {warehouse.notify_lark_last_test_at ? (
          <div className="flex items-center gap-1.5 text-xs">
            {warehouse.has_recent_failure ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            )}
            <span className="text-slate-700">
              {formatDateTime(warehouse.notify_lark_last_test_at)}
            </span>
          </div>
        ) : (
          <span className="text-slate-400 text-xs">—</span>
        )}
      </td>

      {/* Thông báo gần nhất */}
      <td className="px-4 py-3">
        {warehouse.last_notification ? (
          <div className="text-xs">
            <div className="flex items-center gap-1.5 text-slate-700">
              <span
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  warehouse.has_recent_failure ? "bg-rose-500" : "bg-emerald-500"
                }`}
              />
              <span className="font-medium">
                {warehouse.last_notification.waybill_code
                  ? "Đơn " + warehouse.last_notification.waybill_code
                  : EVENT_LABEL[warehouse.last_notification.event_type] ?? "Đơn lỗi"}
              </span>
            </div>
            <div className="text-slate-400 mt-0.5 font-mono">
              {formatDateTime(warehouse.last_notification.sent_at)}
            </div>
          </div>
        ) : (
          <span className="text-slate-400 text-xs">—</span>
        )}
      </td>

      {/* Thao tác — 3 icon button inline, tooltip. Xoá disable khi chưa có
           webhook (thay vì ẩn — layout ổn định, dễ scan). */}
      <td className="px-4 py-3 text-right whitespace-nowrap">
        <div className="inline-flex items-center gap-1">
          <button
            onClick={onEdit}
            className="h-8 w-8 rounded-lg text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 inline-flex items-center justify-center transition-colors"
            title="Sửa cấu hình"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={runTest}
            disabled={testing || !warehouse.notify_lark_webhook_url}
            className="h-8 w-8 rounded-lg text-slate-500 hover:bg-sky-50 hover:text-sky-600 inline-flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 transition-colors"
            title={!warehouse.notify_lark_webhook_url ? "Chưa có webhook để test" : "Test webhook"}
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
          <button
            onClick={clearConfig}
            disabled={!warehouse.notify_lark_webhook_url}
            className="h-8 w-8 rounded-lg text-slate-500 hover:bg-rose-50 hover:text-rose-600 inline-flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 transition-colors"
            title={!warehouse.notify_lark_webhook_url ? "Chưa có cấu hình để xoá" : "Xoá cấu hình"}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  const pages: (number | "...")[] = useMemo(() => {
    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const arr: (number | "...")[] = [1];
    if (page > 3) arr.push("...");
    for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) {
      arr.push(p);
    }
    if (page < totalPages - 2) arr.push("...");
    arr.push(totalPages);
    return arr;
  }, [page, totalPages]);

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="h-8 w-8 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 inline-flex items-center justify-center disabled:opacity-40"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} className="px-2 text-slate-400 text-sm">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`h-8 min-w-8 px-2 rounded-lg text-sm font-medium ${
              p === page
                ? "bg-emerald-500 text-white"
                : "border border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {p}
          </button>
        ),
      )}
      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="h-8 w-8 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 inline-flex items-center justify-center disabled:opacity-40"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// Wrapper luôn mount để animate. Sticky-position với chiều cao full viewport
// tính từ top của main content. Khi open=false, dùng width=0 + translateX +
// opacity để trượt ra phải.
function SidePanelWrapper({
  open,
  warehouse,
  onClose,
  onSaved,
  onReload,
}: {
  open: boolean;
  warehouse: WarehouseRow | null;
  onClose: () => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  return (
    <div
      className="transition-[width,opacity] duration-300 ease-out overflow-hidden shrink-0 h-full"
      style={{
        width: open ? 380 : 0,
        opacity: open ? 1 : 0,
      }}
      aria-hidden={!open}
    >
      <div
        className="transition-transform duration-300 ease-out h-full"
        style={{
          transform: open ? "translateX(0)" : "translateX(100%)",
          width: 380,
        }}
      >
        {warehouse && (
          <EditWebhookPanel
            warehouse={warehouse}
            onClose={onClose}
            onSaved={onSaved}
            onReload={onReload}
          />
        )}
      </div>
    </div>
  );
}

function EditWebhookPanel({
  warehouse,
  onClose,
  onSaved,
  onReload,
}: {
  warehouse: WarehouseRow;
  onClose: () => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [webhookUrl, setWebhookUrl] = useState(warehouse.notify_lark_webhook_url ?? "");
  const [enabled, setEnabled] = useState(warehouse.notify_lark_enabled);
  const [digestDaily, setDigestDaily] = useState(warehouse.notify_lark_digest_daily);
  const [digestWeekly, setDigestWeekly] = useState(warehouse.notify_lark_digest_weekly);
  const [digestMonthly, setDigestMonthly] = useState(warehouse.notify_lark_digest_monthly);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();

  const dirty =
    (webhookUrl.trim() || null) !== warehouse.notify_lark_webhook_url ||
    enabled !== warehouse.notify_lark_enabled ||
    digestDaily !== warehouse.notify_lark_digest_daily ||
    digestWeekly !== warehouse.notify_lark_digest_weekly ||
    digestMonthly !== warehouse.notify_lark_digest_monthly;

  // Reset state khi đổi kho.
  useEffect(() => {
    setWebhookUrl(warehouse.notify_lark_webhook_url ?? "");
    setEnabled(warehouse.notify_lark_enabled);
    setDigestDaily(warehouse.notify_lark_digest_daily);
    setDigestWeekly(warehouse.notify_lark_digest_weekly);
    setDigestMonthly(warehouse.notify_lark_digest_monthly);
    setErr("");
    setRevealed(false);
    setCopied(false);
  }, [
    warehouse.id,
    warehouse.notify_lark_webhook_url,
    warehouse.notify_lark_enabled,
    warehouse.notify_lark_digest_daily,
    warehouse.notify_lark_digest_weekly,
    warehouse.notify_lark_digest_monthly,
  ]);

  const validate = (): string | null => {
    const wh = webhookUrl.trim();
    if (wh.length > 0) {
      if (!wh.startsWith(LARK_WEBHOOK_PREFIX)) {
        return "Webhook phải bắt đầu bằng " + LARK_WEBHOOK_PREFIX;
      }
      const token = wh.slice(LARK_WEBHOOK_PREFIX.length);
      if (!/^[a-f0-9-]{20,}$/i.test(token)) {
        return "Token webhook không đúng định dạng.";
      }
    } else if (enabled) {
      return "Không thể bật khi chưa cấu hình webhook.";
    }
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setErr("");
    setSaving(true);
    try {
      const res = await fetch(`/api/warehouses/${warehouse.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notify_lark_webhook_url: webhookUrl.trim() || null,
          notify_lark_enabled: enabled,
          notify_lark_digest_daily: digestDaily,
          notify_lark_digest_weekly: digestWeekly,
          notify_lark_digest_monthly: digestMonthly,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.message ?? "Lưu thất bại");
        return;
      }
      toast.success("Đã lưu cấu hình Lark cho " + warehouse.name);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    // Nếu có thay đổi chưa lưu, không cho test (test dùng webhook đã lưu).
    if (dirty) {
      toast.error("Lưu thay đổi trước khi test webhook.");
      return;
    }
    if (!warehouse.notify_lark_webhook_url) {
      toast.error("Chưa có webhook để test.");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(`/api/warehouses/${warehouse.id}/test-lark`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast.error(data.message ?? "Test webhook thất bại");
      } else {
        toast.success("Đã gửi tin test tới nhóm Lark");
      }
    } finally {
      setTesting(false);
      onReload();
    }
  };

  const copyWebhook = async () => {
    if (!warehouse.notify_lark_webhook_url) return;
    try {
      await navigator.clipboard.writeText(warehouse.notify_lark_webhook_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Không copy được vào clipboard");
    }
  };

  const testStatus = deriveTestStatus(warehouse);

  return (
    <aside className="w-[380px] h-full bg-white rounded-2xl border border-slate-100 shadow-sm flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">Cấu hình kho</h3>
        <button
          onClick={onClose}
          className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 inline-flex items-center justify-center"
          title="Đóng"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Nội dung scroll */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Info kho */}
        <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
          <div className="h-11 w-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
            <WarehouseIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-slate-800 truncate">{warehouse.name}</p>
            <p className="text-xs text-slate-500 font-mono">{warehouse.code}</p>
          </div>
        </div>

        {/* Toggle trạng thái */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-slate-700">Trạng thái</label>
            <ToggleSwitch
              checked={enabled}
              onChange={(v) => {
                setEnabled(v);
                setErr("");
              }}
              disabled={webhookUrl.trim().length === 0}
              activeLabel="Đang bật"
              inactiveLabel="Đã tắt"
            />
          </div>
          <p className="text-xs text-slate-500">
            Bật/tắt nhận cảnh báo đơn lỗi qua Lark cho kho này.
          </p>
        </div>

        {/* Webhook URL */}
        <div>
          <label className="text-sm font-medium text-slate-700 block mb-1">Webhook Lark</label>
          <p className="text-xs text-slate-500 mb-2">
            Nhập webhook của Lark để nhận thông báo.
          </p>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Lock className="h-3.5 w-3.5" />
            </span>
            <input
              type={revealed ? "text" : "password"}
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrl(e.target.value);
                if (e.target.value.trim().length === 0) setEnabled(false);
                setErr("");
              }}
              placeholder={LARK_WEBHOOK_PREFIX + "..."}
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-xs font-mono focus:outline-none focus:border-emerald-400"
            />
          </div>
        </div>

        {/* Nút hàng: Hiện / Sao chép / Kiểm tra */}
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            disabled={!webhookUrl}
            className="h-9 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {revealed ? "Ẩn" : "Hiện"}
          </button>
          <button
            type="button"
            onClick={copyWebhook}
            disabled={!warehouse.notify_lark_webhook_url}
            className="h-9 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Đã copy" : "Sao chép"}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={testing || dirty || !warehouse.notify_lark_webhook_url}
            className="h-9 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
            title={dirty ? "Lưu thay đổi trước khi test" : ""}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Kiểm tra
          </button>
        </div>

        {err && (
          <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-700">
            {err}
          </div>
        )}

        {/* Card trạng thái test gần nhất */}
        {testStatus && (
          <div className={`rounded-xl border p-3 ${testStatus.wrapClass}`}>
            <div className="flex items-center gap-2">
              {testStatus.icon}
              <span className="font-medium text-sm">{testStatus.label}</span>
            </div>
            {warehouse.notify_lark_last_test_at && (
              <p className="text-xs text-slate-500 mt-1 ml-6">
                Kiểm tra lúc {formatDateTime(warehouse.notify_lark_last_test_at)}
              </p>
            )}
          </div>
        )}

        {/* Section digest — báo cáo tổng hợp theo nhân sự */}
        <div className="pt-3 border-t border-slate-100">
          <label className="text-sm font-medium text-slate-700 block mb-1">
            Báo cáo tổng hợp
          </label>
          <p className="text-xs text-slate-500 mb-3">
            Gửi báo cáo theo nhân sự: tổng đơn, đơn trùng, đơn lỗi... Bấm bật loại kỳ muốn nhận.
          </p>
          <div className="space-y-2">
            <DigestCheckbox
              checked={digestDaily}
              onChange={setDigestDaily}
              disabled={webhookUrl.trim().length === 0}
              label="Báo cáo cuối ngày"
              hint="Gửi lúc 22:00 mỗi ngày"
            />
            <DigestCheckbox
              checked={digestWeekly}
              onChange={setDigestWeekly}
              disabled={webhookUrl.trim().length === 0}
              label="Báo cáo cuối tuần"
              hint="Gửi thứ 2 sáng lúc 08:00"
            />
            <DigestCheckbox
              checked={digestMonthly}
              onChange={setDigestMonthly}
              disabled={webhookUrl.trim().length === 0}
              label="Báo cáo cuối tháng"
              hint="Gửi ngày 1 sáng lúc 08:00"
            />
          </div>
        </div>

        {/* Card thông báo gần nhất */}
        {warehouse.last_notification && (
          <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3">
            <div className="flex items-start gap-2">
              <MessageSquare className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">Thông báo gần nhất</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  {warehouse.last_notification.waybill_code
                    ? `Đơn ${warehouse.last_notification.waybill_code} gửi thành công lúc ${formatDateTime(warehouse.last_notification.sent_at)}`
                    : `${EVENT_LABEL[warehouse.last_notification.event_type] ?? "Đơn lỗi"} — ${formatDateTime(warehouse.last_notification.sent_at)}`}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer sticky */}
      <div className="p-4 border-t border-slate-100 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-10 flex-1 rounded-xl border border-slate-200 text-sm font-medium hover:bg-slate-50"
        >
          Huỷ
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!dirty || saving}
          className="h-10 flex-1 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Lưu thay đổi
        </button>
      </div>
    </aside>
  );
}

// Derive card trạng thái test cuối — dựa vào has_recent_failure + last_test_at.
function deriveTestStatus(w: WarehouseRow): {
  wrapClass: string;
  icon: React.ReactNode;
  label: string;
} | null {
  if (!w.notify_lark_webhook_url) return null;
  if (w.has_recent_failure) {
    return {
      wrapClass: "bg-rose-50 border-rose-200",
      icon: <AlertTriangle className="h-4 w-4 text-rose-600" />,
      label: "Có lỗi gửi gần đây",
    };
  }
  if (w.notify_lark_last_test_at) {
    return {
      wrapClass: "bg-emerald-50 border-emerald-200",
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
      label: "Kết nối thành công",
    };
  }
  return {
    wrapClass: "bg-slate-50 border-slate-200",
    icon: <AlertTriangle className="h-4 w-4 text-slate-400" />,
    label: "Chưa kiểm tra webhook",
  };
}

// Toggle switch iOS-style (dùng cho trạng thái bật/tắt trong panel).
function ToggleSwitch({
  checked,
  onChange,
  disabled,
  activeLabel,
  inactiveLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors ${
          checked ? "bg-emerald-500" : "bg-slate-300"
        } disabled:cursor-not-allowed`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
      <span className={`text-xs font-medium ${checked ? "text-emerald-600" : "text-slate-500"}`}>
        {checked ? activeLabel : inactiveLabel}
      </span>
    </label>
  );
}

// Checkbox digest — dùng ToggleSwitch layout dạng row với label + hint.
function DigestCheckbox({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 p-2 rounded-lg border transition-colors ${
        disabled
          ? "border-slate-100 opacity-50"
          : checked
            ? "border-emerald-200 bg-emerald-50/50 cursor-pointer"
            : "border-slate-100 hover:bg-slate-50 cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-emerald-500 shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-700 font-medium">{label}</div>
        <div className="text-xs text-slate-500">{hint}</div>
      </div>
    </label>
  );
}
