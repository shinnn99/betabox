"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ScrollText,
  Loader2,
  Activity,
  Users,
  ShieldAlert,
  XCircle,
  UserCog,
  Search,
  Download,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Minus,
  Copy,
  Check,
  X,
  Building2,
  Settings,
  Lock,
  LogIn,
  UserPlus,
  UserMinus,
  Headphones,
  Info,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import Select from "@/components/ui/Select";

interface AuditEntry {
  id: number;
  actor_user_id: string;
  actor_email: string | null;
  impersonating_org_id: string | null;
  impersonating_org_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

interface Stats {
  window_days: number;
  current: {
    total: number;
    impersonate: number;
    failed: number;
    high_risk: number;
    active_admins: number;
  };
  delta: {
    total: number | null;
    impersonate: number | null;
    failed: number | null;
    high_risk: number | null;
    active_admins: number | null;
  };
}

type Severity = "critical" | "warning" | "info";
type ResultKind = "success" | "failed";

interface ActionMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  severity: Severity;
}

// Map action code → nhãn tiếng Việt + icon + mức độ. Bất kỳ action lạ nào
// mặc định "info" + Activity icon để không vỡ UI.
const ACTION_META: Record<string, ActionMeta> = {
  "impersonate.start": {
    label: "Phiên hỗ trợ tổ chức",
    icon: Headphones,
    severity: "critical",
  },
  "impersonate.stop": {
    label: "Kết thúc phiên hỗ trợ",
    icon: Headphones,
    severity: "critical",
  },
  "platform.org.impersonate.start": {
    label: "Phiên hỗ trợ tổ chức",
    icon: Headphones,
    severity: "critical",
  },
  "platform.org.impersonate.stop": {
    label: "Kết thúc phiên hỗ trợ",
    icon: Headphones,
    severity: "critical",
  },
  "platform.org.impersonate": {
    label: "Vào xem tổ chức",
    icon: Headphones,
    severity: "critical",
  },
  "org.create": { label: "Tạo tổ chức", icon: Building2, severity: "warning" },
  "org.update": {
    label: "Cập nhật thông tin tổ chức",
    icon: Settings,
    severity: "info",
  },
  "org.update.retention": {
    label: "Cập nhật retention",
    icon: Settings,
    severity: "warning",
  },
  "org.lock": { label: "Khóa tổ chức", icon: Lock, severity: "critical" },
  "org.suspend": { label: "Tạm khóa tổ chức", icon: Lock, severity: "critical" },
  "platform.admin.add": {
    label: "Thêm quản trị",
    icon: UserPlus,
    severity: "warning",
  },
  "platform.admin.remove": {
    label: "Xóa quản trị",
    icon: UserMinus,
    severity: "critical",
  },
  "auth.admin.login": {
    label: "Đăng nhập quản trị",
    icon: LogIn,
    severity: "info",
  },
};

function metaFor(action: string): ActionMeta {
  return (
    ACTION_META[action] ?? {
      label: action,
      icon: Activity,
      severity: "info",
    }
  );
}

function resultOf(entry: AuditEntry): ResultKind {
  if (entry.action.endsWith(".fail") || entry.action.endsWith(".failed"))
    return "failed";
  if (
    entry.metadata &&
    typeof entry.metadata === "object" &&
    "error" in entry.metadata &&
    entry.metadata.error
  ) {
    return "failed";
  }
  return "success";
}

const TIME_WINDOWS = [
  { value: "1", label: "Hôm nay" },
  { value: "7", label: "7 ngày gần đây" },
  { value: "30", label: "30 ngày gần đây" },
  { value: "90", label: "90 ngày gần đây" },
];
const RESULT_OPTIONS = [
  { value: "all", label: "Kết quả: Tất cả" },
  { value: "success", label: "Thành công" },
  { value: "failed", label: "Thất bại" },
];
const SEVERITY_OPTIONS = [
  { value: "all", label: "Mức độ: Tất cả" },
  { value: "critical", label: "Nhạy cảm" },
  { value: "warning", label: "Cảnh báo" },
  { value: "info", label: "Thông thường" },
];

export default function PlatformAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [days, setDays] = useState("7");
  const [q, setQ] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [importantOnly, setImportantOnly] = useState(false);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(
        `/api/platform/audit?limit=200&days=${days}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Không tải được.");
      } else {
        setEntries(data.entries);
        setStats(data.stats);
        setError("");
      }
      setLoading(false);
    })();
  }, [days]);

  // Build dropdown options từ entries có sẵn.
  const actionOptions = useMemo(() => {
    const unique = new Set(entries.map((e) => e.action));
    return [
      { value: "all", label: "Loại hành động: Tất cả" },
      ...[...unique].map((a) => ({ value: a, label: metaFor(a).label })),
    ];
  }, [entries]);

  const actorOptions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const e of entries) {
      if (e.actor_user_id && e.actor_email) {
        unique.set(e.actor_user_id, e.actor_email);
      }
    }
    return [
      { value: "all", label: "Người thực hiện: Tất cả" },
      ...[...unique.entries()].map(([id, email]) => ({ value: id, label: email })),
    ];
  }, [entries]);

  const orgOptions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const e of entries) {
      if (e.impersonating_org_id && e.impersonating_org_name) {
        unique.set(e.impersonating_org_id, e.impersonating_org_name);
      }
    }
    return [
      { value: "all", label: "Tổ chức: Tất cả" },
      ...[...unique.entries()].map(([id, name]) => ({ value: id, label: name })),
    ];
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      const meta = metaFor(e.action);
      const res = resultOf(e);
      if (importantOnly && meta.severity === "info") return false;
      if (q) {
        const qLower = q.toLowerCase();
        const hay = [
          e.actor_email ?? "",
          e.impersonating_org_name ?? "",
          e.action,
          meta.label,
          e.target_id ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(qLower)) return false;
      }
      if (actionFilter !== "all" && e.action !== actionFilter) return false;
      if (actorFilter !== "all" && e.actor_user_id !== actorFilter) return false;
      if (orgFilter !== "all" && e.impersonating_org_id !== orgFilter)
        return false;
      if (resultFilter !== "all" && res !== resultFilter) return false;
      if (severityFilter !== "all" && meta.severity !== severityFilter)
        return false;
      return true;
    });
  }, [
    entries,
    q,
    actionFilter,
    actorFilter,
    orgFilter,
    resultFilter,
    severityFilter,
    importantOnly,
  ]);

  // Group by date. Key = yyyy-mm-dd để giữ thứ tự stable.
  const groups = useMemo(() => {
    const map = new Map<string, AuditEntry[]>();
    for (const e of filtered) {
      const key = e.created_at.slice(0, 10);
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <PlatformLayout
      pageTitle="Nhật ký kiểm toán"
      pageSubtitle="Ghi nhận mọi thao tác của quản trị nền tảng — dùng làm bằng chứng khi có sự cố"
      pageIcon={ScrollText}
    >
      <div className="space-y-4">
        {/* Top row: export button aligned right */}
        <div className="flex justify-end">
          <button
            disabled
            className="h-9 px-3 rounded-xl border border-slate-200 text-slate-500 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            title="Sắp có"
          >
            <Download className="h-3.5 w-3.5" /> Xuất dữ liệu
          </button>
        </div>

        {/* 5 KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard
            icon={Activity}
            iconTone="emerald"
            label="Tổng sự kiện"
            value={stats?.current.total ?? 0}
            delta={stats?.delta.total ?? null}
            days={stats?.window_days ?? 7}
          />
          <KpiCard
            icon={Users}
            iconTone="sky"
            label="Impersonate"
            value={stats?.current.impersonate ?? 0}
            delta={stats?.delta.impersonate ?? null}
            days={stats?.window_days ?? 7}
          />
          <KpiCard
            icon={ShieldAlert}
            iconTone="amber"
            label="Rủi ro cao"
            value={stats?.current.high_risk ?? 0}
            delta={stats?.delta.high_risk ?? null}
            days={stats?.window_days ?? 7}
          />
          <KpiCard
            icon={XCircle}
            iconTone="red"
            label="Thất bại"
            value={stats?.current.failed ?? 0}
            delta={stats?.delta.failed ?? null}
            days={stats?.window_days ?? 7}
            deltaInverted
          />
          <KpiCard
            icon={UserCog}
            iconTone="violet"
            label="Admin hoạt động"
            value={stats?.current.active_admins ?? 0}
            delta={stats?.delta.active_admins ?? null}
            days={stats?.window_days ?? 7}
          />
        </div>

        {/* Layout main + detail panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className={`${selected ? "lg:col-span-2" : "lg:col-span-3"} space-y-3`}>
            {/* Filter row */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-2 h-10 px-3 rounded-xl border border-slate-200 bg-white text-slate-500 flex-1 min-w-[240px]">
                <Search className="h-4 w-4" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Tìm theo email, tổ chức, session id..."
                  className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
                />
              </div>
              <div className="w-40">
                <Select
                  value={days}
                  onChange={setDays}
                  options={TIME_WINDOWS}
                  ariaLabel="Khoảng thời gian"
                />
              </div>
              <div className="w-44">
                <Select
                  value={actionFilter}
                  onChange={setActionFilter}
                  options={actionOptions}
                  ariaLabel="Loại hành động"
                />
              </div>
              <div className="w-44">
                <Select
                  value={actorFilter}
                  onChange={setActorFilter}
                  options={actorOptions}
                  ariaLabel="Người thực hiện"
                />
              </div>
              <div className="w-40">
                <Select
                  value={orgFilter}
                  onChange={setOrgFilter}
                  options={orgOptions}
                  ariaLabel="Tổ chức"
                />
              </div>
              <div className="w-36">
                <Select
                  value={resultFilter}
                  onChange={setResultFilter}
                  options={RESULT_OPTIONS}
                  ariaLabel="Kết quả"
                />
              </div>
              <div className="w-36">
                <Select
                  value={severityFilter}
                  onChange={setSeverityFilter}
                  options={SEVERITY_OPTIONS}
                  ariaLabel="Mức độ"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setImportantOnly((v) => !v)}
                className={`inline-flex items-center gap-2 text-xs text-slate-600 h-8 px-2 rounded-lg hover:bg-slate-50`}
              >
                <span
                  className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
                    importantOnly ? "bg-emerald-500" : "bg-slate-200"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      importantOnly ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </span>
                Chỉ sự kiện quan trọng
              </button>
            </div>

            {error && (
              <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
                {error}
              </div>
            )}

            {loading ? (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 flex items-center justify-center text-slate-500">
                <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
                Đang tải...
              </div>
            ) : filtered.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 text-center text-sm text-slate-500">
                Không tìm thấy sự kiện khớp.
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map(([dateKey, items]) => (
                  <div key={dateKey}>
                    <p className="px-1 pb-2 text-xs text-slate-500">
                      <span className="font-medium text-slate-700">
                        {formatDayLabel(dateKey)}
                      </span>
                      <span className="text-slate-400">
                        {" "}
                        · {formatDateShort(dateKey)}
                      </span>
                    </p>
                    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                      <ul className="divide-y divide-slate-100">
                        {items.map((e) => (
                          <AuditRow
                            key={e.id}
                            entry={e}
                            selected={selected?.id === e.id}
                            onSelect={() => setSelected(e)}
                          />
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selected && (
            <DetailPanel entry={selected} onClose={() => setSelected(null)} />
          )}
        </div>
      </div>
    </PlatformLayout>
  );
}

/* ---------------- Row ---------------- */

function AuditRow({
  entry,
  selected,
  onSelect,
}: {
  entry: AuditEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = metaFor(entry.action);
  const result = resultOf(entry);
  const Icon = meta.icon;
  const iconTone = {
    critical: "bg-red-50 text-red-600 border-red-100",
    warning: "bg-amber-50 text-amber-600 border-amber-100",
    info: "bg-emerald-50 text-emerald-600 border-emerald-100",
  }[meta.severity];
  return (
    <li
      onClick={onSelect}
      className={`p-3 flex items-center gap-3 cursor-pointer transition-colors hover:bg-slate-50/50 ${
        selected ? "bg-emerald-50/40 ring-2 ring-emerald-400 ring-inset" : ""
      }`}
    >
      <div className="text-xs text-slate-500 font-mono w-20 shrink-0">
        {formatTime(entry.created_at)}
      </div>
      <div
        className={`h-9 w-9 rounded-xl border flex items-center justify-center shrink-0 ${iconTone}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-800 truncate">
          {meta.label}
        </p>
        <p className="text-xs text-slate-500 font-mono truncate">
          {entry.action}
        </p>
      </div>
      <div className="text-xs text-slate-600 w-48 shrink-0 truncate hidden md:block">
        {entry.actor_email ?? "—"}
      </div>
      <div className="text-xs text-slate-600 w-40 shrink-0 truncate hidden lg:block">
        {entry.impersonating_org_name ?? "—"}
      </div>
      <ResultBadge result={result} />
      <SeverityBadge severity={meta.severity} />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        className="h-9 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-medium inline-flex items-center gap-1 shrink-0"
      >
        Chi tiết <ChevronDown className="h-3.5 w-3.5 -rotate-90" />
      </button>
    </li>
  );
}

function ResultBadge({ result }: { result: ResultKind }) {
  if (result === "success") {
    return (
      <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
        <Check className="h-3 w-3" /> Thành công
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium bg-red-50 text-red-700 border border-red-200 shrink-0">
      <X className="h-3 w-3" /> Thất bại
    </span>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const style = {
    critical: {
      className: "bg-amber-50 text-amber-700 border-amber-200",
      label: "Nhạy cảm",
    },
    warning: {
      className: "bg-amber-50 text-amber-700 border-amber-200",
      label: "Cảnh báo",
    },
    info: {
      className: "bg-slate-100 text-slate-600 border-slate-200",
      label: "Thông thường",
    },
  }[severity];
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border shrink-0 ${style.className}`}
    >
      {style.label}
    </span>
  );
}

/* ---------------- Detail panel ---------------- */

function DetailPanel({
  entry,
  onClose,
}: {
  entry: AuditEntry;
  onClose: () => void;
}) {
  const meta = metaFor(entry.action);
  const result = resultOf(entry);
  const rawJson = JSON.stringify(
    {
      action: entry.action,
      target_id: entry.target_id,
      metadata: entry.metadata,
    },
    null,
    2,
  );
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 h-fit sticky top-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-800">Chi tiết sự kiện</h2>
        <button
          onClick={onClose}
          className="h-7 w-7 rounded-lg hover:bg-slate-50 text-slate-500 inline-flex items-center justify-center"
          title="Đóng"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <dl className="space-y-2.5 text-sm">
        <DetailRow
          label="Hành động"
          value={
            <div>
              <p className="text-slate-800 font-medium">{meta.label}</p>
              <p className="text-xs font-mono text-slate-500">
                {entry.action}
              </p>
            </div>
          }
          copyable={entry.action}
        />
        <DetailRow
          label="Người thực hiện"
          value={<span className="text-emerald-700">{entry.actor_email ?? "—"}</span>}
        />
        {entry.impersonating_org_name && (
          <DetailRow
            label="Tổ chức"
            value={
              <span className="text-emerald-700">
                {entry.impersonating_org_name}
              </span>
            }
            copyable={entry.impersonating_org_id ?? undefined}
          />
        )}
        <DetailRow label="Kết quả" value={<ResultBadge result={result} />} />
        <DetailRow label="Mức độ" value={<SeverityBadge severity={meta.severity} />} />
        {entry.target_id && (
          <DetailRow
            label="Target ID"
            value={
              <span className="font-mono text-xs">
                {entry.target_id.slice(0, 8)}...
              </span>
            }
            copyable={entry.target_id}
          />
        )}
        <DetailRow
          label="Thời gian"
          value={formatDateTime(entry.created_at)}
        />
        {entry.ip_address && (
          <DetailRow
            label="IP"
            value={<span className="font-mono text-xs">{entry.ip_address}</span>}
          />
        )}
      </dl>

      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700">Raw JSON</p>
            <CopyButton value={rawJson} />
          </div>
          <pre className="mt-1 p-2 rounded-lg bg-slate-50 border border-slate-100 text-[11px] text-slate-700 overflow-x-auto max-h-40">
            {rawJson}
          </pre>
        </div>
      )}

      <div className="mt-4 p-3 rounded-xl bg-amber-50/60 border border-amber-100 text-xs text-amber-800 flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Mọi phiên hỗ trợ đều được ghi nhận để phục vụ kiểm toán và điều tra
          sự cố.
        </span>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: React.ReactNode;
  copyable?: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="text-xs text-slate-500 w-32 shrink-0">{label}</dt>
      <dd className="flex-1 text-sm text-slate-800 min-w-0 flex items-center gap-1.5">
        <div className="min-w-0 flex-1 truncate">{value}</div>
        {copyable && <CopyButton value={copyable} />}
      </dd>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="h-6 w-6 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 inline-flex items-center justify-center shrink-0"
      title="Sao chép"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/* ---------------- KPI card ---------------- */

function KpiCard({
  icon: Icon,
  iconTone,
  label,
  value,
  delta,
  days,
  deltaInverted,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTone: "emerald" | "sky" | "amber" | "red" | "violet";
  label: string;
  value: number;
  delta: number | null;
  days: number;
  deltaInverted?: boolean;
}) {
  const iconMap = {
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    sky: "bg-sky-50 text-sky-600 border-sky-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
    red: "bg-red-50 text-red-600 border-red-100",
    violet: "bg-violet-50 text-violet-600 border-violet-100",
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-3">
      <div className="flex items-center gap-2">
        <div
          className={`h-8 w-8 rounded-lg border flex items-center justify-center ${iconMap[iconTone]}`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-xs text-slate-500 font-medium">{label}</span>
      </div>
      <p className="text-2xl font-bold text-slate-800 mt-1.5 leading-tight">
        {value}
      </p>
      <DeltaLabel delta={delta} days={days} inverted={deltaInverted} />
    </div>
  );
}

function DeltaLabel({
  delta,
  days,
  inverted,
}: {
  delta: number | null;
  days: number;
  inverted?: boolean;
}) {
  if (delta === null) {
    return (
      <p className="text-[11px] text-slate-400 mt-0.5">
        so với {days} ngày trước
      </p>
    );
  }
  if (delta === 0) {
    return (
      <p className="text-[11px] mt-0.5 inline-flex items-center gap-0.5 text-slate-500">
        <Minus className="h-3 w-3" /> Không đổi
      </p>
    );
  }
  const positive = delta > 0;
  // "Positive" trong logic tăng — nhưng "delta tăng" của "Thất bại" là XẤU.
  const good = inverted ? !positive : positive;
  const color = good ? "text-emerald-600" : "text-red-500";
  const ArrowIcon = positive ? ArrowUp : ArrowDown;
  return (
    <p className={`text-[11px] mt-0.5 inline-flex items-center gap-0.5 ${color}`}>
      <ArrowIcon className="h-3 w-3" />
      {Math.abs(delta)}% so với {days} ngày trước
    </p>
  );
}

/* ---------------- Time helpers ---------------- */

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("vi-VN");
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} ${d.toLocaleDateString("vi-VN")}`;
}

function formatDayLabel(dateKey: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (dateKey === today) return "Hôm nay";
  if (dateKey === yesterday) return "Hôm qua";
  return new Date(dateKey).toLocaleDateString("vi-VN", { weekday: "long" });
}
