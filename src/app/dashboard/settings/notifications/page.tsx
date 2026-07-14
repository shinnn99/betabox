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
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/warehouses", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message ?? data.error ?? "Không tải được danh sách kho");
        return;
      }
      setWarehouses(data.warehouses ?? []);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const configured = warehouses.filter((w) => !!w.notify_lark_webhook_url);
  const enabled = configured.filter((w) => w.notify_lark_enabled);
  const disabled = configured.filter((w) => !w.notify_lark_enabled);
  const missing = warehouses.filter((w) => !w.notify_lark_webhook_url);

  return (
    <DashboardLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-slate-800">
                Cấu hình thông báo
              </h1>
              <p className="text-sm text-slate-500">
                Cảnh báo đơn lỗi qua Lark cho quản lý kho.
              </p>
            </div>
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="h-9 px-3 rounded-xl border border-slate-200 text-sm inline-flex items-center gap-2 hover:bg-slate-50 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            Tải lại
          </button>
        </div>

        {/* Panel: cảnh báo tổng thể */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
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
              hint={disabled.length > 0 ? "Có webhook nhưng cố ý tắt" : ""}
            />
            <StatCard
              variant="muted"
              icon={<AlertCircle className="h-4 w-4" />}
              label="Chưa cấu hình"
              value={missing.length}
              hint={missing.length > 0 ? "KHÔNG nhận cảnh báo" : "Tất cả kho đã cấu hình"}
            />
          </div>

          {missing.length > 0 && enabled.length > 0 && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <strong>Cảnh báo an toàn giả:</strong> có kho đang bật + kho chưa cấu hình.
                {" "}Kho chưa cấu hình sẽ <strong>im lặng không nhận</strong> cảnh báo — dễ nhầm là "không có lỗi". Cấu hình đủ trước khi tin số liệu.
              </div>
            </div>
          )}
        </div>

        {/* Panel: hướng dẫn tạo bot */}
        <details className="bg-white border border-slate-200 rounded-2xl">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-700 inline-flex items-center gap-2">
            <Info className="h-4 w-4 text-slate-500" />
            Hướng dẫn tạo Lark Custom Bot
          </summary>
          <div className="px-4 pb-4 text-sm text-slate-600 space-y-2">
            <ol className="list-decimal ml-5 space-y-1.5">
              <li>Mở nhóm Lark quản lý kho → bấm biểu tượng ⚙️ (Settings) → mục <strong>Group Bots</strong> hoặc <strong>Add-ons → Bots</strong>.</li>
              <li>Bấm <strong>Add Bot</strong> → chọn <strong>Custom Bot</strong> (biểu tượng bot chung, không phải bot cụ thể).</li>
              <li>Đặt tên (VD: <em>Betacom Cảnh báo đơn lỗi</em>) → không bật "Signed request" / "IP whitelist".</li>
              <li>Copy <strong>Webhook URL</strong> — dạng <code className="text-xs bg-slate-100 px-1 rounded">{LARK_WEBHOOK_PREFIX}&lt;token&gt;</code></li>
              <li>Dán URL vào ô "Webhook Lark" của kho tương ứng bên dưới → bấm Lưu.</li>
            </ol>
            <p className="text-xs text-slate-500 pt-1">
              Chỉ chấp nhận host <code className="bg-slate-100 px-1 rounded">open.larksuite.com</code>.
              Feishu (open.feishu.cn) không được hỗ trợ đợt này.
            </p>
          </div>
        </details>

        {/* Danh sách kho */}
        <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100">
          {loading && warehouses.length === 0 && (
            <div className="px-4 py-10 text-center text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
            </div>
          )}
          {!loading && warehouses.length === 0 && (
            <div className="px-4 py-10 text-center text-slate-400">
              Chưa có kho nào. Tạo kho trong <a href="/dashboard/warehouses" className="text-emerald-600 underline">Tổ chức &amp; Kho</a> trước.
            </div>
          )}
          {warehouses.map((w) => (
            <WarehouseNotifyRow key={w.id} warehouse={w} onSaved={load} />
          ))}
        </div>

        {/* Panel: debug + verify */}
        <details className="bg-white border border-slate-200 rounded-2xl">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-700 inline-flex items-center gap-2">
            <Info className="h-4 w-4 text-slate-500" />
            Debug &amp; Verify (nếu tin không tới nhóm)
          </summary>
          <div className="px-4 pb-4 text-sm text-slate-600 space-y-2">
            <p>Nếu bấm Lưu xong quét trùng đơn mà không thấy tin trong nhóm Lark, chạy SQL trong Supabase SQL Editor:</p>
            <pre className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs overflow-x-auto">{`SELECT event_type, status, response_status, error_message,
       left(response_body, 300) AS body_preview, sent_at
FROM public.notification_logs
WHERE warehouse_id = '<UUID_KHO>'
ORDER BY sent_at DESC LIMIT 10;`}</pre>
            <p className="text-xs">Xem thêm docs: <code>docs/lark-verify-real-usage.md</code></p>
          </div>
        </details>
      </div>
    </DashboardLayout>
  );
}

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
    ok: "bg-emerald-50 text-emerald-700 border-emerald-100",
    warn: "bg-amber-50 text-amber-700 border-amber-100",
    muted: "bg-slate-50 text-slate-600 border-slate-100",
  }[variant];
  return (
    <div className={`rounded-xl border p-3 ${styleByVariant}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="text-xs opacity-80 mt-0.5">{hint}</div>}
    </div>
  );
}

function WarehouseNotifyRow({
  warehouse,
  onSaved,
}: {
  warehouse: WarehouseRow;
  onSaved: () => void;
}) {
  const [webhookUrl, setWebhookUrl] = useState(warehouse.notify_lark_webhook_url ?? "");
  const [enabled, setEnabled] = useState(warehouse.notify_lark_enabled ?? false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();

  const handleChangeUrl = (v: string) => {
    setWebhookUrl(v);
    setDirty(true);
    setErr("");
    // Nếu xóa URL, tự tắt toggle (form validation server làm điều này, nhưng
    // UI phản ánh ngay cho user).
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
        <div className="flex items-center gap-3 min-w-0">
          <StateDot state={currentState} />
          <div className="min-w-0">
            <div className="font-medium text-slate-800 truncate">{warehouse.name}</div>
            <div className="text-[11px] text-slate-500 font-mono">{warehouse.code}</div>
          </div>
        </div>
        <StateBadge state={currentState} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start">
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1">Webhook Lark</label>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => handleChangeUrl(e.target.value)}
            placeholder={LARK_WEBHOOK_PREFIX + "..."}
            className="w-full h-9 px-3 rounded-lg border border-slate-200 text-xs font-mono focus:outline-none focus:border-emerald-500"
          />
          {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
          {!err && !hasWebhook && (
            <p className="mt-1 text-xs text-slate-500">
              Để trống = tắt thông báo cho kho này (fail-safe im lặng).
            </p>
          )}
        </div>
        <div className="flex flex-col items-start md:items-end gap-2">
          <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggle(e.target.checked)}
              disabled={!hasWebhook || saving}
              className="h-4 w-4"
            />
            <span className="text-slate-700">
              {enabled ? "Đang bật" : "Đang tắt"}
            </span>
          </label>
          <button
            onClick={() => void submit()}
            disabled={!dirty || saving}
            className="h-9 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
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

function StateDot({ state }: { state: "on" | "off" | "missing" }) {
  const cls = state === "on"
    ? "bg-emerald-500"
    : state === "off"
      ? "bg-amber-500"
      : "bg-slate-300";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${cls}`} />;
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
