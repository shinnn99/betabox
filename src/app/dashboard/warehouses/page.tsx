"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Building2,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  X,
  Save,
  UserPlus,
  Home,
  Cpu,
  Users,
  Smartphone,
  Wrench,
  ShieldCheck,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  status: string;
  created_at: string;
  stations_count: number;
  devices_count: number;
  staff_count: number;
  session_fallback_seconds?: number | null;
  notify_lark_webhook_url?: string | null;
  notify_lark_enabled?: boolean;
  packing_timing_config?: {
    max_order_seconds: number | null;
    video_pre_seconds: number | null;
    video_default_post_seconds: number | null;
  };
}

interface DeviceAlert {
  id: string;
  code: string;
  kind: "camera" | "scanner";
  name: string | null;
  status: string;
  last_seen_at: string | null;
}

interface Overview {
  organization: {
    id: string;
    name: string;
    slug: string | null;
    status: string;
    owner_name: string | null;
  };
  totals: {
    warehouses: number;
    warehouses_active: number;
    stations: number;
    stations_in_use: number;
    devices: number;
    devices_online: number;
    devices_offline: number;
    staff: number;
    staff_active_today: number;
    pending_invites: number;
  };
  warehouses: WarehouseRow[];
  device_alerts: DeviceAlert[];
}

export default function OrganizationWarehousePage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<WarehouseRow | null>(null);
  const [editOrg, setEditOrg] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/organization/overview", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được dữ liệu.");
      setLoading(false);
      return;
    }
    setOverview(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onDelete = async (w: WarehouseRow) => {
    const ok = await confirm({
      title: "Xoá kho?",
      message: (
        <>
          Kho <b>{w.name}</b> ({w.code}) sẽ bị xoá. Nhân viên đang gán vào kho này sẽ mất phân công.
        </>
      ),
      confirmLabel: "Xoá",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/warehouses/${w.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Xoá thất bại");
      return;
    }
    toast.success(`Đã xoá kho ${w.code}`);
    load();
  };

  return (
    <DashboardLayout
      pageTitle="Tổ chức & Kho"
      pageSubtitle="Quản lý cấu hình nền cho tổ chức, kho, bàn đóng hàng, thiết bị và nhân sự"
      pageIcon={Building2}
    >
      {loading && !overview && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-10 text-center text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-600 text-sm rounded-2xl px-4 py-3 mb-3 border border-red-100">
          {error}
        </div>
      )}

      {overview && (
        <div className="space-y-3">
          <StatCards overview={overview} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <OrganizationCard overview={overview} onEdit={() => setEditOrg(true)} />
            <StructureCard overview={overview} />
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <WarehouseTable
              loading={loading}
              warehouses={overview.warehouses}
              onCreate={() => setShowCreate(true)}
              onEdit={(w) => setEditing(w)}
              onDelete={onDelete}
            />
          </div>

          <BottomPanels overview={overview} onAddStation={() => { /* nav */ }} />
        </div>
      )}

      {showCreate && (
        <WarehouseDialog
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editing && (
        <WarehouseDialog
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {editOrg && overview && (
        <OrganizationDialog
          initial={overview.organization}
          onClose={() => setEditOrg(false)}
          onSaved={() => {
            setEditOrg(false);
            load();
          }}
        />
      )}
    </DashboardLayout>
  );
}

function StatCards({ overview }: { overview: Overview }) {
  const t = overview.totals;
  const org = overview.organization;
  const cards = [
    {
      label: "Tổ chức",
      value: org.name,
      sub: org.slug ? `Mã: ${org.slug}` : null,
      icon: Building2,
      isText: true,
    },
    {
      label: "Kho hàng",
      value: t.warehouses,
      sub: `${t.warehouses_active} đang hoạt động`,
      icon: Home,
    },
    {
      label: "Bàn đóng hàng",
      value: t.stations,
      sub: `${t.stations_in_use} đang sử dụng`,
      icon: Wrench,
    },
    {
      label: "Thiết bị",
      value: t.devices,
      sub: (
        <>
          <span className="text-emerald-600 font-medium">{t.devices_online} online</span>
          {t.devices_offline > 0 && (
            <>
              {" · "}
              <span className="text-red-500 font-medium">{t.devices_offline} offline</span>
            </>
          )}
        </>
      ),
      icon: Smartphone,
    },
    {
      label: "Nhân sự",
      value: t.staff,
      sub: `${t.staff_active_today} đang làm ca`,
      icon: Users,
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div
            key={c.label}
            className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3"
          >
            <div className="h-11 w-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-slate-500">{c.label}</p>
              <p
                className={`font-bold text-slate-800 truncate ${
                  c.isText ? "text-base" : "text-2xl"
                }`}
                title={String(c.value)}
              >
                {c.value}
              </p>
              {c.sub && <p className="text-[11px] text-slate-500 mt-0.5">{c.sub}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OrganizationCard({
  overview,
  onEdit,
}: {
  overview: Overview;
  onEdit: () => void;
}) {
  const org = overview.organization;
  const rows: Array<[string, string]> = [
    ["Tên tổ chức", org.name],
    ["Mã tổ chức", org.slug ?? "—"],
    ["Chủ sở hữu", org.owner_name ?? "—"],
  ];
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
      <div className="flex items-center justify-between p-4 border-b border-slate-100">
        <p className="font-bold text-slate-800">Thông tin tổ chức</p>
        <button
          onClick={onEdit}
          className="h-8 px-3 rounded-lg border border-slate-200 text-slate-700 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-50"
        >
          <Pencil className="h-3.5 w-3.5" /> Chỉnh sửa thông tin
        </button>
      </div>
      <div className="p-4 space-y-2.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex">
            <span className="text-slate-500 w-32 shrink-0">{label}:</span>
            <span className="text-slate-800 font-medium truncate">{value}</span>
          </div>
        ))}
        <div className="flex">
          <span className="text-slate-500 w-32 shrink-0">Trạng thái:</span>
          <span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
              {org.status === "active" ? "Đang hoạt động" : org.status}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function StructureNode({
  icon: Icon,
  title,
  count,
  className = "",
}: {
  icon: typeof Building2;
  title: string;
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center bg-white border border-slate-200 rounded-[10px] py-2.5 px-4 shadow-[0_1px_2px_rgba(0,0,0,0.02)] ${className}`}
    >
      <Icon className="h-[18px] w-[18px] text-emerald-600 mr-3 shrink-0" />
      <span className="text-slate-700 font-medium text-sm flex-1 text-left">
        {title}
      </span>
      {count !== undefined && (
        <span className="text-slate-700 font-medium text-sm ml-3 font-mono">
          {count}
        </span>
      )}
    </div>
  );
}

function StructureCard({ overview }: { overview: Overview }) {
  const t = overview.totals;
  const lineBg = "bg-emerald-500";
  const lineBorder = "border-emerald-500";
  const mainNodeWidth = "w-[300px] max-w-full";
  const lineGap = "h-4";

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
      <div className="p-4 border-b border-slate-100">
        <p className="font-bold text-slate-800">Cấu trúc vận hành</p>
      </div>
      <div className="p-5">
        <div className="flex flex-col items-center w-full">
          <StructureNode
            icon={Building2}
            title="Tổ chức"
            count={1}
            className={mainNodeWidth}
          />

          <div className={`w-[2px] ${lineGap} ${lineBg}`} />

          <StructureNode
            icon={Home}
            title="Kho hàng"
            count={t.warehouses}
            className={mainNodeWidth}
          />

          <div className={`w-[2px] ${lineGap} ${lineBg}`} />

          <StructureNode
            icon={Wrench}
            title="Bàn đóng hàng"
            count={t.stations}
            className={mainNodeWidth}
          />

          <div className={`w-[2px] ${lineGap} ${lineBg}`} />

          {/* Vòm chia nhánh */}
          <div
            className={`w-[220px] h-[16px] border-t-[2px] border-l-[2px] border-r-[2px] ${lineBorder} rounded-t-[12px]`}
          />

          {/* 2 nhánh con */}
          <div className="relative w-[220px] h-12">
            <div className="absolute top-0 left-0 -translate-x-1/2">
              <StructureNode
                icon={Smartphone}
                title="Thiết bị"
                count={t.devices}
                className="w-[150px]"
              />
            </div>
            <div className="absolute top-0 right-0 translate-x-1/2">
              <StructureNode
                icon={Users}
                title="Nhân sự"
                count={t.staff}
                className="w-[150px]"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WarehouseTable({
  loading,
  warehouses,
  onCreate,
  onEdit,
  onDelete,
}: {
  loading: boolean;
  warehouses: WarehouseRow[];
  onCreate: () => void;
  onEdit: (w: WarehouseRow) => void;
  onDelete: (w: WarehouseRow) => void;
}) {
  return (
    <div>
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-3">
        <p className="font-semibold text-slate-800">Danh sách kho hàng</p>
        <button
          onClick={onCreate}
          className="h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
        >
          <Plus className="h-4 w-4" /> Thêm kho
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/60">
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Tên kho</th>
              <th className="px-4 py-3 font-medium">Địa chỉ</th>
              <th className="px-4 py-3 font-medium">Bàn đóng</th>
              <th className="px-4 py-3 font-medium">Thiết bị</th>
              <th className="px-4 py-3 font-medium">Nhân sự</th>
              <th className="px-4 py-3 font-medium">Trạng thái</th>
              <th className="px-4 py-3 font-medium">Lark</th>
              <th className="px-4 py-3 font-medium text-right w-28">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
                </td>
              </tr>
            )}
            {!loading && warehouses.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  Chưa có kho nào. Bấm &quot;Thêm kho&quot; để tạo kho đầu tiên.
                </td>
              </tr>
            )}
            {warehouses.map((w) => (
              <tr
                key={w.id}
                className="border-t border-slate-100 hover:bg-slate-50/50"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="h-8 w-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                      <Home className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-800">{w.name}</p>
                      <p className="text-[11px] text-slate-500 font-mono">{w.code}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600 text-xs">
                  {w.address ?? "—"}
                </td>
                <td className="px-4 py-3 text-slate-700">{w.stations_count} bàn</td>
                <td className="px-4 py-3 text-slate-700">{w.devices_count} thiết bị</td>
                <td className="px-4 py-3 text-slate-700">{w.staff_count} người</td>
                <td className="px-4 py-3">
                  <StatusPill status={w.status} />
                </td>
                <td className="px-4 py-3">
                  <LarkNotifyBadge
                    hasWebhook={!!w.notify_lark_webhook_url}
                    enabled={w.notify_lark_enabled ?? false}
                  />
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <div className="inline-flex items-center justify-end gap-1">
                    <button
                      onClick={() => onEdit(w)}
                      className="h-8 px-3 rounded-lg text-emerald-600 hover:bg-emerald-50 text-xs font-medium inline-flex items-center gap-1"
                      title="Quản lý"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Quản lý
                    </button>
                    <button
                      onClick={() => onDelete(w)}
                      className="h-8 w-8 rounded-lg hover:bg-red-50 inline-flex items-center justify-center text-red-500"
                      title="Xoá"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
        Hoạt động
      </span>
    );
  }
  if (status === "paused" || status === "suspended") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium">
        Tạm dừng
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-medium">
      {status}
    </span>
  );
}

// Badge trạng thái Lark cho bảng danh sách kho — 3 trạng thái phân biệt
// "câm vì chưa config" vs "câm vì cố ý tắt" vs "đang bật". Chống "an toàn giả":
// nhìn 1 phát biết kho nào không nhận thông báo.
function LarkNotifyBadge({
  hasWebhook,
  enabled,
}: {
  hasWebhook: boolean;
  enabled: boolean;
}) {
  if (!hasWebhook) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs font-medium">
        Chưa cấu hình
      </span>
    );
  }
  if (!enabled) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium">
        Đã tắt
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
      Đang bật
    </span>
  );
}

function BottomPanels({
  overview,
}: {
  overview: Overview;
  onAddStation: () => void;
}) {
  const alerts = overview.device_alerts;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <div className="p-4 border-b border-slate-100">
          <p className="font-bold text-slate-800">Thiết bị cần chú ý</p>
        </div>
        <div className="p-4">
          {alerts.length === 0 && (
            <p className="text-sm text-slate-400 py-4 text-center">
              Không có thiết bị bất thường.
            </p>
          )}
          {alerts.slice(0, 3).map((a) => {
            const minutesAgo =
              a.last_seen_at && now != null
                ? Math.max(
                    1,
                    Math.round((now - new Date(a.last_seen_at).getTime()) / 60000),
                  )
                : null;
            return (
              <div
                key={a.id}
                className="flex items-center gap-3 py-2 border-b last:border-b-0 border-slate-100"
              >
                <div className="h-9 w-9 rounded-xl bg-red-50 text-red-500 flex items-center justify-center shrink-0">
                  {a.kind === "camera" ? (
                    <Cpu className="h-4 w-4" />
                  ) : (
                    <Smartphone className="h-4 w-4" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 font-mono">
                    {a.code}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {a.kind === "camera" ? "Camera" : "Máy quét"}
                    <span className="text-red-500 font-medium"> · Offline</span>
                    {minutesAgo != null && (
                      <span className="text-slate-500"> · {minutesAgo} phút trước</span>
                    )}
                  </p>
                </div>
                <Link
                  href="/dashboard/devices"
                  className="h-8 px-3 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-50"
                >
                  Kiểm tra
                </Link>
              </div>
            );
          })}
          {alerts.length > 0 && (
            <Link
              href="/dashboard/devices"
              className="block mt-2 text-xs font-medium text-emerald-600 hover:text-emerald-700"
            >
              Xem tất cả thiết bị cảnh báo →
            </Link>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <div className="p-4 border-b border-slate-100">
          <p className="font-bold text-slate-800">Nhân sự chờ mời</p>
        </div>
        <div className="p-4 flex items-center gap-4">
          <div className="h-14 w-14 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <UserPlus className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <p className="text-2xl font-bold text-slate-800">
              {overview.totals.pending_invites}
            </p>
            <p className="text-[11px] text-slate-500">lời mời chưa phản hồi</p>
          </div>
          <Link
            href="/dashboard/users"
            className="h-8 px-3 rounded-lg border border-slate-200 text-slate-700 text-xs font-medium hover:bg-slate-50"
          >
            Xem chi tiết
          </Link>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
        <div className="p-4 border-b border-slate-100">
          <p className="font-bold text-slate-800">Cấu hình nhanh</p>
        </div>
        <div className="p-4 grid grid-cols-4 gap-2 text-center">
          <QuickAction icon={Wrench} label="Thêm bàn" href="/dashboard/packing-stations" />
          <QuickAction icon={Cpu} label="Gắn camera" href="/dashboard/devices" />
          <QuickAction icon={UserPlus} label="Gán nhân viên" href="/dashboard/staff" />
          <QuickAction icon={ShieldCheck} label="Tạo vai trò" href="/dashboard/users" />
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  href,
}: {
  icon: typeof Cpu;
  label: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl hover:bg-slate-50 text-slate-700 transition-colors"
    >
      <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
        <Icon className="h-5 w-5" />
      </div>
      <span className="text-[11px] font-medium leading-tight">{label}</span>
    </Link>
  );
}

function WarehouseDialog({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: WarehouseRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    code: initial?.code ?? "",
    name: initial?.name ?? "",
    address: initial?.address ?? "",
    status: initial?.status ?? "active",
    session_fallback_seconds: initial?.session_fallback_seconds ?? 30,
    max_order_seconds:
      initial?.packing_timing_config?.max_order_seconds ?? 600,
    video_pre_seconds:
      initial?.packing_timing_config?.video_pre_seconds ?? 10,
    video_default_post_seconds:
      initial?.packing_timing_config?.video_default_post_seconds ?? 60,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (form.session_fallback_seconds < 1) {
      setErr("Fallback session phải lớn hơn 0.");
      return;
    }
    if (form.max_order_seconds < 60 || form.max_order_seconds > 3600) {
      setErr("Thời gian tối đa một đơn phải trong khoảng 60–3600 giây.");
      return;
    }
    if (form.video_pre_seconds < 0 || form.video_pre_seconds > 120) {
      setErr("Video lấy trước quét phải trong khoảng 0–120 giây.");
      return;
    }
    if (
      form.video_default_post_seconds < 1 ||
      form.video_default_post_seconds > 600
    ) {
      setErr("Video lấy sau (khi chưa có scan kế) phải trong khoảng 1–600 giây.");
      return;
    }
    setSaving(true);
    const url =
      mode === "create" ? "/api/warehouses" : `/api/warehouses/${initial!.id}`;
    const method = mode === "create" ? "POST" : "PATCH";
    const body: Record<string, unknown> = {
      code: form.code,
      name: form.name,
      address: form.address,
    };
    if (mode === "edit") {
      body.status = form.status;
      body.session_fallback_seconds = form.session_fallback_seconds;
      body.packing_timing_config = {
        max_order_seconds: form.max_order_seconds,
        video_pre_seconds: form.video_pre_seconds,
        video_default_post_seconds: form.video_default_post_seconds,
      };
      // Lark webhook: cấu hình ở trang riêng /dashboard/settings/warehouse-config
      // — không nhét vào form này (nhiều thông tin lẫn lộn).
    }
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Lưu thất bại");
      return;
    }
    onSaved();
  };

  return (
    <Modal title={mode === "create" ? "Thêm kho" : `Sửa: ${initial?.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Mã kho" required>
          <input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder="HN01"
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono uppercase"
          />
        </Field>
        <Field label="Tên kho" required>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Kho Hà Nội"
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <Field label="Địa chỉ">
          <input
            value={form.address ?? ""}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        {mode === "edit" && (
          <>
            <Field
              label="Fallback session (giây)"
              hint="Mã vận đơn quét sau khi ca kết thúc trong khoảng này vẫn được gán vào ca đó."
            >
              <input
                type="number"
                min={1}
                required
                value={form.session_fallback_seconds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    session_fallback_seconds: Number(e.target.value),
                  })
                }
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
              />
            </Field>
            <div className="pt-2 mt-2 border-t border-slate-100">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
                Cấu hình clip đơn hàng
              </p>
            </div>
            <Field
              label="Thời gian tối đa một đơn (giây)"
              hint="Đơn kéo dài quá ngưỡng này sẽ bị đóng bằng timeout. Clip cũng không dài quá ngưỡng này. Khuyến nghị 600 (10 phút)."
            >
              <input
                type="number"
                min={60}
                max={3600}
                required
                value={form.max_order_seconds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    max_order_seconds: Number(e.target.value),
                  })
                }
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
              />
            </Field>
            <Field
              label="Video lấy trước lúc quét (giây)"
              hint="Bao nhiêu giây trước thời điểm quét đơn sẽ có trong clip. Khuyến nghị 10."
            >
              <input
                type="number"
                min={0}
                max={120}
                required
                value={form.video_pre_seconds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    video_pre_seconds: Number(e.target.value),
                  })
                }
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
              />
            </Field>
            <Field
              label="Video lấy sau khi chưa có quét kế (giây)"
              hint="Dùng khi đơn cuối ca hoặc chưa có đơn kế. Khuyến nghị 60."
            >
              <input
                type="number"
                min={1}
                max={600}
                required
                value={form.video_default_post_seconds}
                onChange={(e) =>
                  setForm({
                    ...form,
                    video_default_post_seconds: Number(e.target.value),
                  })
                }
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
              />
            </Field>
            <Field label="Trạng thái">
              <Select
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v })}
                options={[
                  { value: "active", label: "Hoạt động" },
                  { value: "inactive", label: "Ngừng" },
                ]}
              />
            </Field>
          </>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Lưu
          </button>
        </div>
      </form>
    </Modal>
  );
}

function OrganizationDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Overview["organization"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: initial.name ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    const res = await fetch("/api/organization", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Lưu thất bại");
      return;
    }
    onSaved();
  };

  return (
    <Modal title="Chỉnh sửa thông tin tổ chức" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Tên tổ chức" required>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Lưu
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Lock body scroll khi modal mở — chặn browser auto-scroll trang phía sau
  // khi dropdown/input trong modal focus gần bottom viewport (2026-07-23 bug).
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
