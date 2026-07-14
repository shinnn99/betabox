"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Bell,
  Loader2,
  RefreshCcw,
  Save,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Info,
  ChevronDown,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useToast } from "@/components/ui/Toast";

// Match với LARK_WEBHOOK_PREFIX trong src/app/api/warehouses/[id]/route.ts.
const LARK_WEBHOOK_PREFIX = "https://open.larksuite.com/open-apis/bot/v2/hook/";

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  status: string;
  notify_lark_webhook_url?: string | null;
  notify_lark_enabled?: boolean;
}

export default function NotificationsSettingsPage() {
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/warehouses", { cache: "no-store" });
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

  const configured = warehouses.filter((w) => !!w.notify_lark_webhook_url);
  const enabled = configured.filter((w) => w.notify_lark_enabled);
  const disabled = configured.filter((w) => !w.notify_lark_enabled);
  const missing = warehouses.filter((w) => !w.notify_lark_webhook_url);
  const hasSilentGap = missing.length > 0 && enabled.length > 0;

  return (
    <DashboardLayout
      pageTitle="Cấu hình thông báo"
      pageSubtitle="Cảnh báo đơn lỗi qua Lark cho quản lý kho"
      pageIcon={Bell}
    >
      <div className="space-y-4">
        {/* Stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatCard
            variant="ok"
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Đang bật"
            value={enabled.length}
            hint={enabled.length > 0 ? "Đang nhận cảnh báo Lark" : "Chưa kho nào bật"}
          />
          <StatCard
            variant="warn"
            icon={<XCircle className="h-4 w-4" />}
            label="Đã tắt"
            value={disabled.length}
            hint={disabled.length > 0 ? "Có webhook nhưng cố ý tắt" : "—"}
          />
          <StatCard
            variant="muted"
            icon={<AlertCircle className="h-4 w-4" />}
            label="Chưa cấu hình"
            value={missing.length}
            hint={missing.length > 0 ? "KHÔNG nhận cảnh báo" : "Tất cả kho đã cấu hình"}
          />
        </div>

        {/* Cảnh báo an-toàn-giả */}
        {hasSilentGap && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">Cảnh báo an toàn giả</p>
              <p className="mt-0.5">
                Có kho đang bật + kho chưa cấu hình. Kho chưa cấu hình sẽ{" "}
                <strong>im lặng không nhận</strong> cảnh báo — dễ nhầm là "không có lỗi".
                Cấu hình đủ trước khi tin số liệu tổng.
              </p>
            </div>
          </div>
        )}

        {/* Hướng dẫn tạo Bot — accordion */}
        <Accordion
          title="Hướng dẫn tạo Lark Custom Bot"
          defaultOpen={missing.length === warehouses.length}
        >
          <ol className="list-decimal ml-5 space-y-1.5 text-sm text-slate-600">
            <li>
              Mở nhóm Lark quản lý kho → bấm biểu tượng ⚙️ (Settings) → mục{" "}
              <strong>Group Bots</strong> hoặc <strong>Add-ons → Bots</strong>.
            </li>
            <li>
              Bấm <strong>Add Bot</strong> → chọn <strong>Custom Bot</strong> (biểu tượng bot chung).
            </li>
            <li>
              Đặt tên (VD: <em>Betacom Cảnh báo đơn lỗi</em>) → không bật "Signed request" / "IP whitelist".
            </li>
            <li>
              Copy <strong>Webhook URL</strong> — dạng{" "}
              <code className="text-xs bg-slate-100 px-1 rounded">{LARK_WEBHOOK_PREFIX}&lt;token&gt;</code>
            </li>
            <li>Dán URL vào ô "Webhook Lark" của kho tương ứng → bấm Lưu.</li>
          </ol>
          <p className="text-xs text-slate-500 pt-2">
            Chỉ chấp nhận host <code className="bg-slate-100 px-1 rounded">open.larksuite.com</code>. Feishu (open.feishu.cn) không được hỗ trợ đợt này.
          </p>
        </Accordion>

        {/* Danh sách kho */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center gap-3">
            <p className="text-sm text-slate-500">
              {warehouses.length > 0
                ? `${warehouses.length} kho — cấu hình webhook riêng cho từng kho`
                : "Chưa có kho nào"}
            </p>
            <button
              onClick={load}
              disabled={loading}
              className="ml-auto h-9 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm inline-flex items-center gap-2 disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Làm mới
            </button>
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
              {error}
            </div>
          )}

          <div className="divide-y divide-slate-100">
            {loading && warehouses.length === 0 && (
              <div className="px-4 py-10 text-center text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
              </div>
            )}
            {!loading && warehouses.length === 0 && !error && (
              <div className="px-4 py-10 text-center text-slate-400 text-sm">
                Chưa có kho nào. Tạo kho trong{" "}
                <a href="/dashboard/warehouses" className="text-emerald-600 hover:underline">
                  Tổ chức &amp; Kho
                </a>{" "}
                trước.
              </div>
            )}
            {warehouses.map((w) => (
              <WarehouseNotifyRow key={w.id} warehouse={w} onSaved={load} toast={toast} />
            ))}
          </div>
        </div>

        {/* Debug SQL — accordion */}
        <Accordion title="Debug & Verify (nếu tin không tới nhóm)" defaultOpen={false}>
          <p className="text-sm text-slate-600 mb-2">
            Nếu bấm Lưu xong quét trùng đơn mà không thấy tin trong nhóm Lark, chạy SQL trong Supabase SQL Editor:
          </p>
          <pre className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs overflow-x-auto text-slate-700">{`SELECT event_type, status, response_status, error_message,
       left(response_body, 300) AS body_preview, sent_at
FROM public.notification_logs
WHERE warehouse_id = '<UUID_KHO>'
ORDER BY sent_at DESC LIMIT 10;`}</pre>
          <p className="text-xs text-slate-500 mt-2">
            Xem thêm docs: <code className="bg-slate-100 px-1 rounded">docs/lark-verify-real-usage.md</code>
          </p>
        </Accordion>
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  variant,
  icon,
  label,
  value,
  hint,
}: {
  variant: "ok" | "warn" | "muted";
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
}) {
  const styleByVariant = {
    ok: {
      bg: "bg-white",
      iconBg: "bg-emerald-50 text-emerald-600",
      valueColor: "text-emerald-700",
    },
    warn: {
      bg: "bg-white",
      iconBg: "bg-amber-50 text-amber-600",
      valueColor: "text-amber-700",
    },
    muted: {
      bg: "bg-white",
      iconBg: "bg-slate-100 text-slate-500",
      valueColor: "text-slate-700",
    },
  }[variant];
  return (
    <div className={`${styleByVariant.bg} rounded-2xl border border-slate-100 shadow-sm p-4`}>
      <div className="flex items-center gap-2.5">
        <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${styleByVariant.iconBg}`}>
          {icon}
        </div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          {label}
        </div>
      </div>
      <div className={`mt-2 text-2xl font-semibold ${styleByVariant.valueColor}`}>
        {value}
      </div>
      <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
    </div>
  );
}

function Accordion({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <Info className="h-4 w-4 text-slate-500" />
        <span className="flex-1 text-left">{title}</span>
        <ChevronDown
          className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t border-slate-100">{children}</div>}
    </div>
  );
}

interface ToastApi {
  success: (m: string) => void;
  error: (m: string) => void;
}

function WarehouseNotifyRow({
  warehouse,
  onSaved,
  toast,
}: {
  warehouse: WarehouseRow;
  onSaved: () => void;
  toast: ToastApi;
}) {
  const [webhookUrl, setWebhookUrl] = useState(warehouse.notify_lark_webhook_url ?? "");
  const [enabled, setEnabled] = useState(warehouse.notify_lark_enabled ?? false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState("");

  const handleChangeUrl = (v: string) => {
    setWebhookUrl(v);
    setDirty(true);
    setErr("");
    if (v.trim().length === 0 && enabled) setEnabled(false);
  };

  const handleToggle = (v: boolean) => {
    setEnabled(v);
    setDirty(true);
    setErr("");
  };

  const submit = async () => {
    setErr("");
    const wh = webhookUrl.trim();
    if (wh.length > 0) {
      if (!wh.startsWith(LARK_WEBHOOK_PREFIX)) {
        setErr("Webhook phải bắt đầu bằng " + LARK_WEBHOOK_PREFIX);
        return;
      }
      const token = wh.slice(LARK_WEBHOOK_PREFIX.length);
      if (!/^[a-f0-9-]{20,}$/i.test(token)) {
        setErr("Token webhook không đúng định dạng (UUID hoặc chuỗi hex-dash 20+ ký tự).");
        return;
      }
    } else if (enabled) {
      setErr("Không thể bật khi chưa cấu hình webhook.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/warehouses/${warehouse.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notify_lark_webhook_url: wh || null,
          notify_lark_enabled: enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.message ?? data.error ?? "Lưu thất bại");
        toast.error(data.message ?? data.error ?? "Lưu thất bại");
        return;
      }
      setDirty(false);
      toast.success("Đã lưu cấu hình Lark cho " + warehouse.name);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const hasWebhook = webhookUrl.trim().length > 0;
  const currentState: "on" | "off" | "missing" = !hasWebhook
    ? "missing"
    : enabled
      ? "on"
      : "off";

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
            <StateIcon state={currentState} />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-slate-800 truncate">{warehouse.name}</p>
            <p className="text-[11px] text-slate-500 font-mono">{warehouse.code}</p>
          </div>
        </div>
        <StateBadge state={currentState} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start">
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1">
            Webhook Lark
          </label>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => handleChangeUrl(e.target.value)}
            placeholder={LARK_WEBHOOK_PREFIX + "..."}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-emerald-400"
          />
          {err ? (
            <p className="mt-1 text-xs text-red-600">{err}</p>
          ) : !hasWebhook ? (
            <p className="mt-1 text-xs text-slate-500">
              Để trống = tắt thông báo cho kho này (fail-safe im lặng).
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-start md:items-end gap-2">
          <label className="inline-flex items-center gap-2 cursor-pointer text-sm select-none">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggle(e.target.checked)}
              disabled={!hasWebhook || saving}
              className="h-4 w-4 accent-emerald-500"
            />
            <span className="text-slate-700">
              {enabled ? "Đang bật" : "Đang tắt"}
            </span>
          </label>
          <button
            onClick={submit}
            disabled={!dirty || saving}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Lưu
          </button>
        </div>
      </div>

      {hasWebhook && enabled && !dirty && (
        <div className="text-xs text-slate-500 flex items-center gap-1">
          <ExternalLink className="h-3 w-3" />
          Thử: quét trùng 1 đơn ở kho này → tin Lark tới nhóm trong ~5-10 giây.
        </div>
      )}
    </div>
  );
}

function StateIcon({ state }: { state: "on" | "off" | "missing" }) {
  if (state === "on") return <CheckCircle2 className="h-4 w-4" />;
  if (state === "off") return <XCircle className="h-4 w-4 text-amber-600" />;
  return <AlertCircle className="h-4 w-4 text-slate-500" />;
}

function StateBadge({ state }: { state: "on" | "off" | "missing" }) {
  if (state === "missing") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs font-medium shrink-0">
        Chưa cấu hình
      </span>
    );
  }
  if (state === "off") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium shrink-0">
        Đã tắt
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium shrink-0">
      Đang bật
    </span>
  );
}
