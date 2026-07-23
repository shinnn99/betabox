"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Building2,
  Users,
  Warehouse,
  ArrowRight,
  Loader2,
  Search,
  Plus,
  X,
  Copy,
  Check,
  Camera,
  Cpu,
  Package,
  AlertTriangle,
  Eye,
  Activity,
  Lock,
  Clock,
  Filter,
  ShoppingCart,
  Video,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import Select from "@/components/ui/Select";

type StatusFilter = "all" | "active" | "suspended" | "expiring";

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "Tất cả trạng thái" },
  { value: "active", label: "Đang hoạt động" },
  { value: "suspended", label: "Tạm khóa" },
  { value: "expiring", label: "Sắp hết hạn" },
];

async function impersonateOrg(orgId: string) {
  const res = await fetch("/api/platform/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ?? data.error ?? "Vào tổ chức thất bại");
  }
  // Cookie đã set → redirect về dashboard (proxy sẽ ký token từ cookie).
  window.location.href = "/dashboard";
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  retention_days: number | null;
  owner: { full_name: string | null; email: string | null } | null;
  stats: {
    users: number;
    warehouses: number;
    cameras: number;
    stations: number;
    agents_total: number;
    agents_online: number;
    orders_today: number;
    agent_errors_24h: number;
  };
}

interface CreatedOrgResult {
  organization: { id: string; name: string; slug: string };
  owner: { user_id: string; email: string; full_name: string; password?: string };
}

export default function PlatformOrgsPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreatedOrgResult | null>(null);

  const reload = async () => {
    const res = await fetch("/api/platform/orgs", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được danh sách.");
    } else {
      setOrgs(data.orgs);
      setError("");
    }
    setLoading(false);
  };

  useEffect(() => {
    reload();
  }, []);

  // "Đang hoạt động" = status === 'active'. Các nhãn khác đang là placeholder
  // — chưa có gói dịch vụ / ngày hết hạn nên "Tạm khóa" và "Sắp hết hạn" tạm
  // bằng 0 (không đếm sai). Sẽ nối vào khi phần suspend + entitlement land
  // sau 26/7.
  const totals = {
    all: orgs.length,
    active: orgs.filter((o) => o.status === "active").length,
    suspended: orgs.filter((o) => o.status === "suspended").length,
    expiring: 0,
  };

  const filtered = orgs.filter((o) => {
    const matchQ =
      o.name.toLowerCase().includes(q.toLowerCase()) ||
      o.slug.toLowerCase().includes(q.toLowerCase());
    if (!matchQ) return false;
    if (statusFilter === "all") return true;
    if (statusFilter === "active") return o.status === "active";
    if (statusFilter === "suspended") return o.status === "suspended";
    return false; // expiring: chưa có tín hiệu, luôn rỗng
  });

  return (
    <PlatformLayout
      pageTitle="Tổ chức"
      pageSubtitle="Danh sách mọi tổ chức trên hệ thống — bấm để vào xem"
      pageIcon={Building2}
    >
      <div className="space-y-4">
        {/* 4 stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={Building2}
            iconTone="emerald"
            label="Tổng tổ chức"
            value={totals.all}
            hint="Tất cả tổ chức trên hệ thống"
          />
          <StatCard
            icon={Activity}
            iconTone="green"
            label="Đang hoạt động"
            value={totals.active}
            hint="Tổ chức đang hoạt động"
          />
          <StatCard
            icon={Lock}
            iconTone="amber"
            label="Tạm khóa"
            value={totals.suspended}
            hint="Tổ chức tạm khóa"
          />
          <StatCard
            icon={Clock}
            iconTone="violet"
            label="Sắp hết hạn"
            value={totals.expiring}
            hint="Trong 30 ngày tới"
          />
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 h-11 px-3 rounded-xl border border-slate-200 bg-white text-slate-500 flex-1 min-w-[280px]">
            <Search className="h-4 w-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm theo tên hoặc slug tổ chức..."
              className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
            />
          </div>
          <div className="w-56">
            <Select
              size="lg"
              leadingIcon={<Filter className="h-4 w-4" />}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              options={STATUS_FILTER_OPTIONS}
              ariaLabel="Lọc theo trạng thái"
            />
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="h-11 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 shadow-sm ml-auto"
          >
            <Plus className="h-4 w-4" /> Tạo tổ chức mới
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-8 flex items-center justify-center text-slate-500 bg-white rounded-2xl border border-slate-100 shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
            Đang tải...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 bg-white rounded-2xl border border-slate-100 shadow-sm">
            {q || statusFilter !== "all"
              ? "Không tìm thấy tổ chức khớp."
              : "Chưa có tổ chức nào."}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((org) => (
              <OrgListRow
                key={org.id}
                org={org}
                onImpersonate={() =>
                  impersonateOrg(org.id).catch((e) => setError(e.message))
                }
              />
            ))}
          </div>
        )}

        {/* Pagination footer — chưa phân trang server-side, hiện thông tin. */}
        {!loading && filtered.length > 0 && (
          <div className="text-xs text-slate-500 px-1">
            Hiển thị {filtered.length} / {orgs.length} tổ chức
          </div>
        )}
      </div>

      {showCreate && (
        <CreateOrgModal
          onClose={() => setShowCreate(false)}
          onCreated={(result) => {
            setCreatedResult(result);
            setShowCreate(false);
            reload();
          }}
        />
      )}

      {createdResult && (
        <CreatedResultModal
          result={createdResult}
          onClose={() => setCreatedResult(null)}
        />
      )}
    </PlatformLayout>
  );
}

function StatCard({
  icon: Icon,
  iconTone,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTone: "emerald" | "green" | "amber" | "violet";
  label: string;
  value: number;
  hint: string;
}) {
  const toneMap = {
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    green: "bg-green-50 text-green-600 border-green-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
    violet: "bg-violet-50 text-violet-600 border-violet-100",
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3">
      <div
        className={`h-12 w-12 rounded-xl border flex items-center justify-center shrink-0 ${toneMap[iconTone]}`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-2xl font-bold text-slate-800 leading-tight">
          {value}
        </p>
        <p className="text-[11px] text-slate-400 mt-0.5 truncate">{hint}</p>
      </div>
    </div>
  );
}


function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium ${
        isActive
          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
          : "bg-slate-100 text-slate-600 border border-slate-200"
      }`}
    >
      {isActive ? "Đang hoạt động" : status}
    </span>
  );
}

function AgentHealth({
  online,
  total,
}: {
  online: number;
  total: number;
}) {
  if (total === 0) {
    return <span className="text-slate-400">—</span>;
  }
  const allOnline = online === total;
  const noneOnline = online === 0;
  const color = allOnline
    ? "text-emerald-600"
    : noneOnline
      ? "text-red-500"
      : "text-amber-600";
  return (
    <span className={`font-medium ${color}`}>
      {online}/{total}
    </span>
  );
}

function OrgListRow({
  org,
  onImpersonate,
}: {
  org: OrgRow;
  onImpersonate: () => void;
}) {
  const hasErrors = org.stats.agent_errors_24h > 0;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
      <div className="flex items-stretch gap-4">
        {/* Left: identity */}
        <div className="flex items-start gap-3 w-72 shrink-0">
          <div className="h-12 w-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100">
            <Building2 className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-slate-800 truncate">{org.name}</p>
              <StatusBadge status={org.status} />
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-xs">
              <span className="text-slate-400">Slug:</span>
              <span className="font-mono text-slate-600 truncate">
                {org.slug}
              </span>
            </div>
            {org.owner && (
              <div className="mt-1.5 text-xs">
                <span className="text-slate-400">Chủ: </span>
                <span className="text-slate-700 font-medium">
                  {org.owner.full_name ?? "—"}
                </span>
                {org.owner.email && (
                  <div className="text-slate-400 truncate">
                    {org.owner.email}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Middle: 2 rows × 4 counters, divided by border */}
        <div className="flex-1 min-w-0 grid grid-cols-4 gap-y-3">
          <CounterCell icon={Users} label="Người dùng" value={org.stats.users} />
          <CounterCell icon={Warehouse} label="Kho" value={org.stats.warehouses} />
          <CounterCell icon={Camera} label="Camera" value={org.stats.cameras} />
          <CounterCell icon={Package} label="Bàn" value={org.stats.stations} />

          <div className="col-span-4 border-t border-slate-100 -my-1" />

          <CounterCell
            icon={Cpu}
            label="Agent online"
            valueNode={
              <AgentHealth
                online={org.stats.agents_online}
                total={org.stats.agents_total}
              />
            }
          />
          <CounterCell
            icon={ShoppingCart}
            label="Đơn hôm nay"
            value={org.stats.orders_today}
          />
          <CounterCell
            icon={AlertTriangle}
            iconTone={hasErrors ? "danger" : "muted"}
            label="Lỗi 24h"
            valueNode={
              <span
                className={
                  hasErrors
                    ? "text-red-600 font-semibold"
                    : "text-slate-800 font-semibold"
                }
              >
                {org.stats.agent_errors_24h}
              </span>
            }
          />
          <CounterCell
            icon={Video}
            label="Lưu video"
            valueNode={
              <span className="text-slate-800 font-semibold">
                {org.retention_days != null
                  ? `${org.retention_days} ngày`
                  : "—"}
              </span>
            }
          />
        </div>

        {/* Right: actions stacked */}
        <div className="flex flex-col gap-2 shrink-0 w-32 justify-center">
          <Link
            href={`/platform/orgs/${org.id}`}
            className="h-10 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium inline-flex items-center justify-center gap-1.5"
          >
            <Eye className="h-4 w-4" /> Chi tiết
          </Link>
          <button
            onClick={onImpersonate}
            className="h-10 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-1.5"
          >
            Vào xem <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function CounterCell({
  icon: Icon,
  iconTone = "muted",
  label,
  value,
  valueNode,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: "muted" | "danger";
  label: string;
  value?: number;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon
        className={`h-4 w-4 shrink-0 ${
          iconTone === "danger" ? "text-red-500" : "text-slate-400"
        }`}
      />
      <div className="min-w-0">
        <div className="text-[11px] text-slate-500 leading-tight">{label}</div>
        <div className="text-base leading-tight mt-0.5">
          {valueNode ?? (
            <span className="text-slate-800 font-semibold">{value}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateOrgModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreatedOrgResult) => void;
}) {
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [orgName, setOrgName] = useState("");
  const [slugOverride, setSlugOverride] = useState("");
  const [manualPassword, setManualPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_email: ownerEmail,
          owner_full_name: ownerFullName,
          owner_phone: ownerPhone || null,
          organization_name: orgName,
          slug_override: slugOverride || undefined,
          password: manualPassword || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.message ?? data.error ?? "Tạo thất bại.");
        return;
      }
      onCreated(data as CreatedOrgResult);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800">Tạo tổ chức mới</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-slate-100 text-slate-500 flex items-center justify-center"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Tên tổ chức <span className="text-red-500">*</span>
            </label>
            <input
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Ví dụ: Betacom Kho Đà Nẵng"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Slug (URL định danh — bỏ trắng để auto)
            </label>
            <input
              value={slugOverride}
              onChange={(e) => setSlugOverride(e.target.value)}
              placeholder="Auto từ tên tổ chức"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <hr className="border-slate-100" />
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Email chủ tài khoản <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@example.com"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Họ tên chủ tài khoản <span className="text-red-500">*</span>
            </label>
            <input
              required
              value={ownerFullName}
              onChange={(e) => setOwnerFullName(e.target.value)}
              placeholder="Nguyễn Văn A"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Số điện thoại (tùy chọn)
            </label>
            <input
              value={ownerPhone}
              onChange={(e) => setOwnerPhone(e.target.value)}
              placeholder="0912345678"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Mật khẩu (bỏ trắng để tự tạo random)
            </label>
            <input
              type="text"
              value={manualPassword}
              onChange={(e) => setManualPassword(e.target.value)}
              placeholder="Auto random nếu bỏ trắng"
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <p className="text-xs text-slate-400 mt-1">
              Tối thiểu 8 ký tự. Auto random sẽ trả về ở màn kết quả để copy.
            </p>
          </div>

          {err && (
            <div className="p-2 rounded-lg bg-red-50 text-red-600 text-xs">
              {err}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-10 rounded-lg border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 h-10 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "Đang tạo..." : "Tạo tổ chức"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreatedResultModal({
  result,
  onClose,
}: {
  result: CreatedOrgResult;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-emerald-50">
          <h2 className="font-semibold text-emerald-900">Đã tạo tổ chức</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-emerald-100 text-emerald-700 flex items-center justify-center"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            Chép thông tin dưới đây gửi khách. Mật khẩu chỉ hiển thị 1 lần —
            đóng cửa sổ này là không xem lại được.
          </div>

          <Field
            label="Tên tổ chức"
            value={result.organization.name}
            copyKey="name"
            copied={copied}
            onCopy={copy}
          />
          <Field
            label="Slug"
            value={result.organization.slug}
            copyKey="slug"
            copied={copied}
            onCopy={copy}
            mono
          />
          <Field
            label="Email đăng nhập"
            value={result.owner.email}
            copyKey="email"
            copied={copied}
            onCopy={copy}
          />
          {result.owner.password && (
            <Field
              label="Mật khẩu (auto random — chỉ hiển thị lần này)"
              value={result.owner.password}
              copyKey="password"
              copied={copied}
              onCopy={copy}
              mono
              highlight
            />
          )}

          <button
            onClick={onClose}
            className="w-full h-10 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-sm font-semibold"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  copyKey,
  copied,
  onCopy,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div
          className={`flex-1 h-10 px-3 rounded-lg border text-sm flex items-center ${
            highlight
              ? "border-emerald-300 bg-emerald-50 text-emerald-900 font-semibold"
              : "border-slate-200 bg-slate-50 text-slate-700"
          } ${mono ? "font-mono" : ""}`}
        >
          {value}
        </div>
        <button
          onClick={() => onCopy(value, copyKey)}
          className="h-10 w-10 rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center justify-center text-slate-600"
          title="Sao chép"
        >
          {copied === copyKey ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
