"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Building2,
  ChevronLeft,
  Loader2,
  Users,
  ClipboardList,
  LayoutDashboard,
  AlertTriangle,
  Cpu,
  Camera,
  Warehouse,
  Package,
  Clock,
  Copy,
  Check,
  RefreshCw,
  Headphones,
  Pencil,
  MoreVertical,
  ShieldCheck,
  ShoppingCart,
  Video,
  Info,
  Sliders,
  Wrench,
  Lock,
  Archive,
  BookOpen,
  Bot,
  Package2,
  Eye,
  ChevronRight,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";

interface OrgDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
    logo_url: string | null;
    retention_days: number | null;
    created_at: string;
    updated_at: string;
  };
  owner: {
    user_id: string;
    full_name: string | null;
    phone: string | null;
    email: string | null;
    last_sign_in_at: string | null;
  } | null;
  totals: {
    users: number;
    warehouses: number;
    cameras: number;
    stations: number;
    agents_total: number;
    agents_online: number;
    orders_today: number;
    orders_failed_today: number;
  };
  last_activity_at: string | null;
  config: {
    webhooks_configured: number;
  };
  recent: {
    last_order: {
      waybill_code: string | null;
      status: string;
      at: string;
    } | null;
    last_clip: {
      id: string;
      status: string;
      at: string;
    } | null;
    last_impersonate: {
      actor_email: string | null;
      at: string;
    } | null;
  };
  agents: Array<{
    id: string;
    code: string;
    name: string | null;
    status: string;
    last_seen_at: string | null;
    online: boolean;
  }>;
  members: Array<{
    user_id: string;
    full_name: string | null;
    phone: string | null;
    role: string;
    status: string;
    email: string | null;
    last_sign_in_at: string | null;
    created_at: string;
  }>;
  agent_logs: Array<{
    id: number;
    agent_id: string;
    level: string;
    message: string;
    emitted_at: string;
  }>;
  platform_audit: Array<{
    id: string;
    action: string;
    actor_email: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
}

type TabKey = "overview" | "members" | "audit" | "config";

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
  window.location.href = "/dashboard";
}

export default function PlatformOrgDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("overview");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/platform/orgs/${id}`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) {
      setError(body.message ?? body.error ?? "Không tải được chi tiết tổ chức.");
      setLoading(false);
      return;
    }
    setData(body as OrgDetail);
    setError("");
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <PlatformLayout pageTitle="Chi tiết tổ chức" pageIcon={Building2}>
      <div className="space-y-4">
        <Link
          href="/platform"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="h-4 w-4" /> Danh sách tổ chức
        </Link>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
            {error}
          </div>
        )}

        {loading && !data && (
          <div className="p-8 flex items-center justify-center text-slate-500 bg-white rounded-2xl border border-slate-100 shadow-sm">
            <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
            Đang tải...
          </div>
        )}

        {data && (
          <>
            <OrgHeader
              data={data}
              onImpersonate={() =>
                impersonateOrg(data.organization.id).catch((e) =>
                  setError((e as Error).message),
                )
              }
            />

            <TabBar tab={tab} onChange={setTab} counts={data} />

            {/* Grid 2 cột: main (2/3) + sidebar (1/3). Trên mobile stack. */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                {tab === "overview" && <OverviewMain data={data} onReload={load} />}
                {tab === "members" && <MembersTab members={data.members} />}
                {tab === "audit" && (
                  <AuditTab
                    logs={data.agent_logs}
                    audit={data.platform_audit}
                  />
                )}
                {tab === "config" && <ConfigTab data={data} />}
              </div>
              <div className="space-y-4">
                <OrgInfoCard data={data} />
                <ConfigCard data={data} />
                <AdminActionsCard />
              </div>
            </div>
          </>
        )}
      </div>
    </PlatformLayout>
  );
}

/* ---------------- Header ---------------- */

function OrgHeader({
  data,
  onImpersonate,
}: {
  data: OrgDetail;
  onImpersonate: () => void;
}) {
  const { organization: org, owner, totals, last_activity_at } = data;
  const systemHealthy =
    totals.agents_total === 0
      ? null // chưa có agent, không judge
      : totals.agents_online === totals.agents_total && data.agent_logs.length === 0;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100">
          <Building2 className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-base font-semibold text-slate-800">{org.name}</h1>
            <StatusBadge status={org.status} />
            {systemHealthy != null && (
              <span
                className={`inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium border ${
                  systemHealthy
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-amber-50 text-amber-700 border-amber-200"
                }`}
              >
                <ShieldCheck className="h-3 w-3" />
                {systemHealthy ? "Hệ thống ổn định" : "Cần chú ý"}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 font-mono mt-0.5">{org.slug}</p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500 flex-wrap">
            {owner && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" /> Chủ sở hữu:{" "}
                <span className="text-slate-700">
                  {owner.full_name ?? "—"}
                </span>
                {owner.email && (
                  <span className="text-slate-400 ml-1">· {owner.email}</span>
                )}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> Ngày tạo:{" "}
              <span className="text-slate-700">
                {formatDateShort(org.created_at)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> Hoạt động gần nhất:{" "}
              <span className="text-slate-700">
                {last_activity_at ? formatRelative(last_activity_at) : "Chưa có"}
              </span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            disabled
            className="h-9 px-3 rounded-xl border border-slate-200 text-slate-500 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            title="Chưa mở"
          >
            <Pencil className="h-3.5 w-3.5" /> Chỉnh sửa
          </button>
          <button
            onClick={onImpersonate}
            className="h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow-sm"
          >
            <Headphones className="h-3.5 w-3.5" /> Bắt đầu hỗ trợ
          </button>
          <button
            disabled
            className="h-9 w-9 rounded-xl border border-slate-200 text-slate-400 inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
            title="Thêm"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Tab bar ---------------- */

function TabBar({
  tab,
  onChange,
  counts,
}: {
  tab: TabKey;
  onChange: (t: TabKey) => void;
  counts: OrgDetail;
}) {
  const tabs: Array<{
    key: TabKey;
    label: string;
    icon: typeof LayoutDashboard;
    badge?: number;
  }> = [
    { key: "overview", label: "Tổng quan", icon: LayoutDashboard },
    { key: "members", label: "Thành viên", icon: Users, badge: counts.totals.users },
    {
      key: "audit",
      label: "Nhật ký",
      icon: ClipboardList,
      badge: counts.agent_logs.length + counts.platform_audit.length,
    },
    { key: "config", label: "Cấu hình", icon: Sliders },
  ];
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-1 inline-flex flex-wrap gap-0.5 w-full lg:w-auto">
      {tabs.map((t) => {
        const active = tab === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs rounded-lg transition-colors ${
              active
                ? "bg-emerald-500 text-white font-semibold"
                : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
            {typeof t.badge === "number" && t.badge > 0 && (
              <span
                className={`text-[10px] ${
                  active ? "text-emerald-50" : "text-slate-400"
                }`}
              >
                ({t.badge})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- Overview main ---------------- */

function OverviewMain({
  data,
  onReload,
}: {
  data: OrgDetail;
  onReload: () => void;
}) {
  const { totals, organization: org, agents, agent_logs, recent } = data;
  const allAgentsOnline =
    totals.agents_total > 0 && totals.agents_online === totals.agents_total;
  const noAgents = totals.agents_total === 0;
  const warnCount = agent_logs.length;
  return (
    <div className="space-y-4">
      {/* 4 KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={Bot}
          iconTone="emerald"
          label="Agent"
          value={`${totals.agents_online}/${totals.agents_total}`}
          hint={
            noAgents
              ? "Chưa có agent"
              : allAgentsOnline
                ? "Tất cả online"
                : `${totals.agents_total - totals.agents_online} agent offline`
          }
          hintTone={noAgents ? "muted" : allAgentsOnline ? "good" : "warn"}
        />
        <KpiCard
          icon={Package2}
          iconTone="sky"
          label="Đơn hôm nay"
          value={String(totals.orders_today)}
          hint={
            totals.orders_today === 0
              ? "Không có hoạt động"
              : `Có ${totals.orders_today} đơn`
          }
          hintTone={totals.orders_today === 0 ? "muted" : "good"}
        />
        <KpiCard
          icon={AlertTriangle}
          iconTone={warnCount > 0 ? "amber" : "amber-light"}
          label="Cảnh báo 24 giờ"
          value={String(warnCount)}
          hint={
            warnCount === 0
              ? "Hệ thống bình thường"
              : `${warnCount} cảnh báo cần xử lý`
          }
          hintTone={warnCount === 0 ? "good" : "warn"}
        />
        <KpiCard
          icon={Video}
          iconTone="violet"
          label="Lưu video"
          value={
            org.retention_days != null ? `${org.retention_days} ngày` : "Chưa đặt"
          }
          valueTone={org.retention_days == null ? "warn" : "default"}
          hint={org.retention_days == null ? "Thiết lập ngay" : "Đã cấu hình"}
          hintTone={org.retention_days == null ? "warn" : "muted"}
        />
      </div>

      {/* Tài nguyên tổ chức — 1 hàng inline */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-3">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs font-semibold text-slate-700">
            Tài nguyên tổ chức
          </span>
          <InlineResource icon={Users} label="Người dùng" value={totals.users} />
          <span className="text-slate-300 text-xs">·</span>
          <InlineResource icon={Warehouse} label="Kho" value={totals.warehouses} />
          <span className="text-slate-300 text-xs">·</span>
          <InlineResource icon={Camera} label="Camera" value={totals.cameras} />
          <span className="text-slate-300 text-xs">·</span>
          <InlineResource
            icon={Package}
            label="Bàn đóng hàng"
            value={totals.stations}
          />
        </div>
      </div>

      {/* Tình trạng vận hành */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <SectionHeader
          icon={Cpu}
          title="Tình trạng vận hành"
          onRefresh={onReload}
        />
        {agents.length === 0 ? (
          <EmptyAgents />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/50 text-xs text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Agent</th>
                  <th className="text-left px-4 py-2 font-medium">Máy trạm</th>
                  <th className="text-left px-4 py-2 font-medium">Heartbeat gần nhất</th>
                  <th className="text-left px-4 py-2 font-medium">Phiên bản</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            a.online ? "bg-emerald-500" : "bg-slate-300"
                          }`}
                        />
                        <span className="font-mono text-xs">{a.code}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {a.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {a.last_seen_at ? formatRelative(a.last_seen_at) : "chưa từng"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cảnh báo gần đây */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <SectionHeader
          icon={AlertTriangle}
          title="Cảnh báo gần đây"
          onRefresh={onReload}
        />
        {agent_logs.length === 0 ? (
          <div className="p-6 flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 shrink-0">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="font-medium text-slate-800">
                Không có WARN/ERROR trong 24 giờ qua
              </p>
              <p className="text-sm text-slate-500 mt-0.5">
                Hệ thống đang hoạt động ổn định.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {agent_logs.slice(0, 8).map((l) => (
              <li key={l.id} className="p-3 flex items-start gap-2">
                <span
                  className={`inline-flex h-5 px-1.5 rounded text-[10px] font-medium shrink-0 mt-0.5 ${
                    l.level === "error"
                      ? "bg-red-50 text-red-700 border border-red-200"
                      : "bg-amber-50 text-amber-700 border border-amber-200"
                  }`}
                >
                  {l.level.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-700 break-words">
                    {l.message}
                  </p>
                  <p className="text-slate-400 text-[11px] mt-0.5">
                    {formatRelative(l.emitted_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Hoạt động gần đây */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="h-4 w-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-700">
            Hoạt động gần đây
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <RecentTile
            icon={ShoppingCart}
            label="Đơn gần nhất"
            primary={recent.last_order?.waybill_code ?? "—"}
            secondary={
              recent.last_order ? formatRelative(recent.last_order.at) : "—"
            }
          />
          <RecentTile
            icon={Video}
            label="Clip gần nhất"
            primary={recent.last_clip?.status ?? "—"}
            secondary={
              recent.last_clip ? formatRelative(recent.last_clip.at) : "—"
            }
          />
          <RecentTile
            icon={Headphones}
            label="Truy cập hỗ trợ gần nhất"
            primary={recent.last_impersonate?.actor_email ?? "—"}
            secondary={
              recent.last_impersonate
                ? formatRelative(recent.last_impersonate.at)
                : "—"
            }
          />
        </div>
      </section>
    </div>
  );
}

/* ---------------- Sidebar cards ---------------- */

function OrgInfoCard({ data }: { data: OrgDetail }) {
  const { organization: org, owner } = data;
  const [copiedSlug, setCopiedSlug] = useState(false);
  const copySlug = async () => {
    await navigator.clipboard.writeText(org.slug);
    setCopiedSlug(true);
    setTimeout(() => setCopiedSlug(false), 2000);
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <Info className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">Thông tin tổ chức</h2>
      </div>
      <dl className="space-y-2.5 text-sm">
        <InfoRow label="Chủ sở hữu" value={owner?.full_name ?? "—"} />
        <InfoRow
          label="Email"
          value={owner?.email ?? "—"}
          muted
        />
        <InfoRow
          label="Slug"
          value={
            <button
              onClick={copySlug}
              className="inline-flex items-center gap-1 font-mono text-sm text-slate-700 hover:text-emerald-600"
              title="Sao chép"
            >
              {org.slug}
              {copiedSlug ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-slate-400" />
              )}
            </button>
          }
        />
        <InfoRow label="Ngày tạo" value={formatDateShort(org.created_at)} muted />
        <InfoRow
          label="Trạng thái"
          value={<StatusBadge status={org.status} />}
        />
      </dl>
    </div>
  );
}

function ConfigCard({ data }: { data: OrgDetail }) {
  const { organization: org, config } = data;
  const retentionSet = org.retention_days != null;
  const hasWebhook = config.webhooks_configured > 0;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <Sliders className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">Cấu hình</h2>
      </div>
      <dl className="space-y-2.5 text-sm">
        <InfoRow
          label="Thời gian lưu video"
          value={
            <span
              className={
                retentionSet
                  ? "text-slate-800 font-medium"
                  : "text-amber-600 font-medium"
              }
            >
              {retentionSet ? `${org.retention_days} ngày` : "Chưa đặt"}
            </span>
          }
        />
        <InfoRow
          label="Webhook"
          value={
            <span
              className={
                hasWebhook
                  ? "text-slate-800 font-medium"
                  : "text-amber-600 font-medium"
              }
            >
              {hasWebhook
                ? `${config.webhooks_configured} kho`
                : "Chưa cấu hình"}
            </span>
          }
        />
        <InfoRow label="Chính sách" value="Mặc định" muted />
      </dl>
    </div>
  );
}

function AdminActionsCard() {
  // Hoãn sau 26/7 theo cọc project_platform_admin_mvp_sequencing_2026_07_23.
  // Giữ button dạng đóng để Hạnh biết sắp có mà không dùng nhầm.
  const items: Array<{ icon: typeof Lock; label: string; tone: "danger" | "muted" | "neutral" }> = [
    { icon: Lock, label: "Tạm khóa tổ chức", tone: "danger" },
    { icon: Archive, label: "Lưu trữ tổ chức", tone: "neutral" },
    { icon: BookOpen, label: "Xem nhật ký hỗ trợ", tone: "neutral" },
  ];
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <Wrench className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">Thao tác quản trị</h2>
      </div>
      <div className="space-y-2">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.label}
              disabled
              className={`w-full h-10 px-3 rounded-xl border text-sm inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                it.tone === "danger"
                  ? "border-red-100 text-red-600 bg-red-50/40"
                  : "border-slate-200 text-slate-600 bg-white"
              }`}
              title="Sắp có"
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{it.label}</span>
              <ChevronRight className="h-4 w-4 text-slate-300" />
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-400 mt-2">
        Các thao tác này sẽ mở sau khi hệ thống có schema tạm khóa.
      </p>
    </div>
  );
}

/* ---------------- Tabs khác ---------------- */

function MembersTab({ members }: { members: OrgDetail["members"] }) {
  if (members.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 text-sm text-slate-500 text-center">
        Chưa có thành viên nào.
      </div>
    );
  }
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/50 text-xs text-slate-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Họ tên</th>
              <th className="text-left px-4 py-2 font-medium">Email</th>
              <th className="text-left px-4 py-2 font-medium">Điện thoại</th>
              <th className="text-left px-4 py-2 font-medium">Vai trò</th>
              <th className="text-left px-4 py-2 font-medium">Trạng thái</th>
              <th className="text-left px-4 py-2 font-medium">Đăng nhập gần nhất</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((m) => (
              <tr key={m.user_id}>
                <td className="px-4 py-3">{m.full_name ?? "—"}</td>
                <td className="px-4 py-3 text-slate-600">{m.email ?? "—"}</td>
                <td className="px-4 py-3 text-slate-500">{m.phone ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
                    {m.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={m.status} />
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {m.last_sign_in_at
                    ? formatRelative(m.last_sign_in_at)
                    : "chưa từng"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditTab({
  logs,
  audit,
}: {
  logs: OrgDetail["agent_logs"];
  audit: OrgDetail["platform_audit"];
}) {
  return (
    <div className="space-y-4">
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <SectionHeader icon={Eye} title="Hoạt động Platform Admin (7 ngày qua)" />
        {audit.length === 0 ? (
          <div className="p-6 text-sm text-slate-500 text-center">
            Chưa có hoạt động Platform Admin đụng tổ chức này.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {audit.map((a) => (
              <li key={a.id} className="p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10px] bg-slate-100 text-slate-700 px-1.5 h-5 inline-flex items-center rounded">
                    {a.action}
                  </span>
                  <span className="text-sm text-slate-600">
                    {a.actor_email ?? "—"}
                  </span>
                </div>
                <p className="text-slate-400 text-[11px] mt-1">
                  {formatRelative(a.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <SectionHeader
          icon={AlertTriangle}
          title="Cảnh báo agent WARN/ERROR (24h)"
        />
        {logs.length === 0 ? (
          <div className="p-6 text-sm text-slate-500 text-center">
            Không có WARN/ERROR trong 24h qua.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {logs.map((l) => (
              <li key={l.id} className="p-3 flex items-start gap-2">
                <span
                  className={`inline-flex h-5 px-1.5 rounded text-[10px] font-medium shrink-0 mt-0.5 ${
                    l.level === "error"
                      ? "bg-red-50 text-red-700 border border-red-200"
                      : "bg-amber-50 text-amber-700 border border-amber-200"
                  }`}
                >
                  {l.level.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-700 break-words">
                    {l.message}
                  </p>
                  <p className="text-slate-400 text-[11px] mt-0.5">
                    {formatRelative(l.emitted_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConfigTab({ data }: { data: OrgDetail }) {
  const { organization: org, config } = data;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
      <h2 className="text-sm font-semibold text-slate-700">Cấu hình chi tiết</h2>
      <p className="text-sm text-slate-500">
        Cấu hình chi tiết mỗi kho (webhook, camera, thời gian) nằm trong dashboard
        tổ chức — bấm <em>Bắt đầu hỗ trợ</em> để vào xem.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="p-3 rounded-xl border border-slate-100 bg-slate-50/40">
          <p className="text-xs text-slate-500">Thời gian lưu video</p>
          <p className="text-base font-semibold text-slate-800 mt-0.5">
            {org.retention_days != null
              ? `${org.retention_days} ngày`
              : "Chưa đặt"}
          </p>
        </div>
        <div className="p-3 rounded-xl border border-slate-100 bg-slate-50/40">
          <p className="text-xs text-slate-500">Webhook (Lark)</p>
          <p className="text-base font-semibold text-slate-800 mt-0.5">
            {config.webhooks_configured > 0
              ? `${config.webhooks_configured} kho đã bật`
              : "Chưa cấu hình"}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Bits ---------------- */

function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium border ${
        isActive
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-slate-100 text-slate-600 border-slate-200"
      }`}
    >
      {isActive ? "Đang hoạt động" : status}
    </span>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  onRefresh,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
      <Icon className="h-4 w-4 text-slate-500" />
      <h2 className="text-sm font-semibold text-slate-700 flex-1">{title}</h2>
      {onRefresh && (
        <button
          onClick={onRefresh}
          className="h-7 w-7 rounded-lg hover:bg-slate-50 text-slate-400 hover:text-slate-600 inline-flex items-center justify-center"
          title="Làm mới"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function KpiCard({
  icon: Icon,
  iconTone,
  label,
  value,
  valueTone = "default",
  hint,
  hintTone = "muted",
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTone: "emerald" | "sky" | "amber" | "amber-light" | "violet";
  label: string;
  value: string;
  valueTone?: "default" | "warn";
  hint: string;
  hintTone?: "muted" | "good" | "warn";
}) {
  const iconMap = {
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    sky: "bg-sky-50 text-sky-600 border-sky-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
    "amber-light": "bg-amber-50/60 text-amber-500 border-amber-100",
    violet: "bg-violet-50 text-violet-600 border-violet-100",
  };
  const hintClass = {
    muted: "text-slate-500",
    good: "text-emerald-600",
    warn: "text-amber-600",
  }[hintTone];
  const valueClass =
    valueTone === "warn" ? "text-amber-600" : "text-slate-800";
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
      <p className={`text-2xl font-bold mt-1.5 leading-tight ${valueClass}`}>{value}</p>
      <p className={`text-[11px] mt-0.5 ${hintClass}`}>{hint}</p>
    </div>
  );
}

function InlineResource({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <Icon className="h-3.5 w-3.5 text-slate-400" />
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-800 font-semibold">{value}</span>
    </span>
  );
}

function InfoRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-slate-500 shrink-0">{label}</dt>
      <dd
        className={`text-sm text-right min-w-0 truncate ${
          muted ? "text-slate-500" : "text-slate-800"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function RecentTile({
  icon: Icon,
  label,
  primary,
  secondary,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  primary: string;
  secondary: string;
}) {
  const empty = primary === "—";
  return (
    <div className="p-3 rounded-xl border border-slate-100 bg-slate-50/40">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p
        className={`text-sm mt-1 truncate ${
          empty ? "text-slate-400" : "text-slate-800 font-medium"
        }`}
      >
        {primary}
      </p>
      <p className="text-[11px] text-slate-400 mt-0.5">{secondary}</p>
    </div>
  );
}

function EmptyAgents() {
  return (
    <div className="p-6 flex items-center gap-4">
      <div className="h-16 w-16 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center border border-slate-100 shrink-0">
        <Bot className="h-8 w-8" />
      </div>
      <div>
        <p className="font-semibold text-slate-800">
          Chưa có agent nào được kết nối
        </p>
        <p className="text-sm text-slate-500 mt-0.5">
          Kết nối agent để theo dõi hoạt động và nhận hỗ trợ nhanh chóng.
        </p>
        <button
          disabled
          className="mt-3 h-9 px-3 rounded-xl border border-slate-200 text-slate-600 text-sm inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          title="Tài liệu chưa gắn"
        >
          <BookOpen className="h-4 w-4" /> Hướng dẫn kết nối
        </button>
      </div>
    </div>
  );
}

/* ---------------- Time helpers ---------------- */

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString("vi-VN");
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s trước`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} ngày trước`;
  return new Date(iso).toLocaleDateString("vi-VN");
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("vi-VN");
}
