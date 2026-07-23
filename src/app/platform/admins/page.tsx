"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Users,
  UserPlus,
  Trash2,
  Loader2,
  X,
  ShieldCheck,
  Shield,
  Crown,
  MailOpen,
  Search,
  Filter,
  Eye,
  MoreVertical,
  Lock,
  Monitor,
  Clock,
  User,
  Info,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
import Select from "@/components/ui/Select";
import { usePlatformSession } from "@/lib/usePlatformSession";

interface AdminRow {
  id: string;
  email: string;
  role: "platform_owner" | "platform_support";
  status: string;
  created_at: string;
  created_by: string | null;
  created_by_email: string | null;
  notes: string | null;
  last_sign_in_at: string | null;
  mfa_enabled: boolean;
}

type RoleFilter = "all" | "platform_owner" | "platform_support";
type StatusFilter = "all" | "active" | "disabled";

const ROLE_OPTIONS = [
  { value: "all", label: "Vai trò: Tất cả" },
  { value: "platform_owner", label: "Chủ nền tảng" },
  { value: "platform_support", label: "Hỗ trợ nền tảng" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "Trạng thái: Tất cả" },
  { value: "active", label: "Đang hoạt động" },
  { value: "disabled", label: "Đã tắt" },
];

export default function PlatformAdminsPage() {
  const { session } = usePlatformSession();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/platform/admins", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được.");
    } else {
      setAdmins(data.admins);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRevoke = async (a: AdminRow) => {
    if (a.id === session?.userId) {
      alert("Không thể tự xóa quyền của mình.");
      return;
    }
    if (
      !confirm(
        `Xóa quyền ${
          a.role === "platform_owner" ? "Chủ nền tảng" : "Hỗ trợ nền tảng"
        } của ${a.email}?`
      )
    ) {
      return;
    }
    const res = await fetch(`/api/platform/admins/${a.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message ?? data.error ?? "Xóa lỗi");
      return;
    }
    load();
  };

  const isOwner = session?.platformRole === "platform_owner";

  const totals = {
    all: admins.length,
    active: admins.filter((a) => a.status === "active").length,
    owners: admins.filter((a) => a.role === "platform_owner").length,
    pending: 0, // Chờ mời — chưa có invite flow
  };

  const filtered = admins.filter((a) => {
    const matchQ =
      !q ||
      a.email.toLowerCase().includes(q.toLowerCase()) ||
      (a.notes ?? "").toLowerCase().includes(q.toLowerCase());
    if (!matchQ) return false;
    if (roleFilter !== "all" && a.role !== roleFilter) return false;
    if (statusFilter !== "all" && a.status !== statusFilter) return false;
    return true;
  });

  // Self record — cho sidebar Quyền & bảo mật.
  const self = admins.find((a) => a.id === session?.userId) ?? null;

  return (
    <PlatformLayout
      pageTitle="Quản trị nền tảng"
      pageSubtitle="Người có quyền truy cập tầng quản trị của hệ thống"
      pageIcon={Users}
    >
      <div className="space-y-4">
        {/* 4 stat cards + sidebar dạng grid 4 (main) + 1 (sidebar) hoặc gộp: theo
            screenshot, 4 stat card nằm ngang với sidebar bên cạnh — nhưng thực
            tế 4 card riêng, sidebar riêng cột dọc. Dùng grid ngoài 4/1 kéo dài
            cả stat cards + main list. */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-3 space-y-4">
            {/* 4 stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                icon={ShieldCheck}
                iconTone="emerald"
                label="Tổng quản trị"
                value={totals.all}
                hint="Tổng số quản trị trong hệ thống"
              />
              <StatCard
                icon={Users}
                iconTone="green"
                label="Đang hoạt động"
                value={totals.active}
                hint="Quản trị viên đang hoạt động"
              />
              <StatCard
                icon={Crown}
                iconTone="emerald"
                label="Chủ nền tảng"
                value={totals.owners}
                hint="Người sở hữu nền tảng"
              />
              <StatCard
                icon={MailOpen}
                iconTone="amber"
                label="Chờ mời"
                value={totals.pending}
                hint="Đang chờ chấp nhận lời mời"
              />
            </div>

            {/* Filter row + add button */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 h-11 px-3 rounded-xl border border-slate-200 bg-white text-slate-500 flex-1 min-w-[240px]">
                <Search className="h-4 w-4" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Tìm theo email hoặc tên quản trị..."
                  className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
                />
              </div>
              <div className="w-48">
                <Select
                  size="lg"
                  leadingIcon={<Filter className="h-4 w-4" />}
                  value={roleFilter}
                  onChange={(v) => setRoleFilter(v as RoleFilter)}
                  options={ROLE_OPTIONS}
                  ariaLabel="Lọc theo vai trò"
                />
              </div>
              <div className="w-48">
                <Select
                  size="lg"
                  leadingIcon={<Filter className="h-4 w-4" />}
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as StatusFilter)}
                  options={STATUS_OPTIONS}
                  ariaLabel="Lọc theo trạng thái"
                />
              </div>
              {isOwner && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="h-11 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 shadow-sm ml-auto"
                >
                  <UserPlus className="h-4 w-4" /> Thêm quản trị
                </button>
              )}
            </div>

            {error && (
              <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">
                {error}
              </div>
            )}

            {/* Main table */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              {loading ? (
                <div className="p-8 flex items-center justify-center text-slate-500">
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
                  Đang tải...
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  {q || roleFilter !== "all" || statusFilter !== "active"
                    ? "Không tìm thấy quản trị khớp."
                    : "Chưa có quản trị nền tảng nào."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50/50 text-xs text-slate-500">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-medium">
                          Quản trị viên
                        </th>
                        <th className="text-left px-3 py-2.5 font-medium">
                          Vai trò
                        </th>
                        <th className="text-left px-3 py-2.5 font-medium">
                          Trạng thái
                        </th>
                        <th className="text-left px-3 py-2.5 font-medium">
                          Ngày tạo
                        </th>
                        <th className="text-left px-3 py-2.5 font-medium">
                          Truy cập gần nhất
                        </th>
                        <th className="text-right px-4 py-2.5 font-medium">
                          Thao tác
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filtered.map((a) => (
                        <AdminTableRow
                          key={a.id}
                          admin={a}
                          isSelf={a.id === session?.userId}
                          canRevoke={isOwner && a.id !== session?.userId}
                          onRevoke={() => onRevoke(a)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar: Quyền & bảo mật của self + Lưu ý */}
          <div className="space-y-4">
            <SecurityCard self={self} sessionRole={session?.platformRole} />
            <NoticeCard />
          </div>
        </div>
      </div>

      {showAdd && <AddAdminModal onClose={() => setShowAdd(false)} onSuccess={load} />}
    </PlatformLayout>
  );
}

/* ---------------- Table row ---------------- */

function AdminTableRow({
  admin,
  isSelf,
  canRevoke,
  onRevoke,
}: {
  admin: AdminRow;
  isSelf: boolean;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const RoleIcon = admin.role === "platform_owner" ? Crown : Shield;
  const roleLabel =
    admin.role === "platform_owner" ? "Chủ nền tảng" : "Hỗ trợ nền tảng";
  const roleTone =
    admin.role === "platform_owner"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : "bg-slate-100 text-slate-600 border-slate-200";
  const isActive = admin.status === "active";
  return (
    <tr className="hover:bg-slate-50/50">
      <td className="px-4 py-3">
        <div className="flex items-start gap-3">
          <div
            className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 border ${roleTone}`}
          >
            <RoleIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold text-slate-800 truncate">
                {admin.email || "—"}
              </span>
              {isSelf && (
                <span className="text-[10px] px-1.5 h-4 inline-flex items-center rounded bg-emerald-100 text-emerald-700 font-semibold">
                  BẠN
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {roleLabel}
              {admin.created_by_email && (
                <>
                  <span className="text-slate-400"> · </span>
                  <span>Được thêm bởi {admin.created_by_email}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">{roleLabel}</td>
      <td className="px-3 py-3">
        <span
          className={`inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium border ${
            isActive
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-slate-100 text-slate-600 border-slate-200"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isActive ? "bg-emerald-500" : "bg-slate-400"
            }`}
          />
          {isActive ? "Đang hoạt động" : admin.status}
        </span>
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        {formatDateShort(admin.created_at)}
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        {admin.last_sign_in_at ? formatRelative(admin.last_sign_in_at) : "chưa từng"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <button
            disabled
            className="h-9 px-3 rounded-xl border border-slate-200 text-slate-500 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
            title="Chưa mở"
          >
            <Eye className="h-3.5 w-3.5" /> Chi tiết
          </button>
          {canRevoke ? (
            <button
              onClick={onRevoke}
              className="h-9 w-9 rounded-xl border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-400 inline-flex items-center justify-center"
              title="Xóa quyền"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : (
            <button
              disabled
              className="h-9 w-9 rounded-xl border border-slate-200 text-slate-300 inline-flex items-center justify-center disabled:cursor-not-allowed"
              title={isSelf ? "Không thể tự xóa quyền" : "Chỉ chủ nền tảng"}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ---------------- Sidebar cards ---------------- */

function SecurityCard({
  self,
  sessionRole,
}: {
  self: AdminRow | null;
  sessionRole?: "platform_owner" | "platform_support";
}) {
  const roleLabel =
    (self?.role ?? sessionRole) === "platform_owner"
      ? "Chủ nền tảng"
      : "Hỗ trợ nền tảng";
  const mfa = self?.mfa_enabled ?? false;
  const lastSignIn = self?.last_sign_in_at ?? null;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-semibold text-slate-800">Quyền & bảo mật</h2>
      </div>
      <dl className="space-y-3 text-sm">
        <SecurityRow icon={User} label="Vai trò" value={roleLabel} />
        <SecurityRow
          icon={ShieldCheck}
          label="Quyền"
          value={
            (self?.role ?? sessionRole) === "platform_owner"
              ? "Toàn quyền quản trị"
              : "Truy cập hỗ trợ"
          }
        />
        <SecurityRow
          icon={Lock}
          label="MFA"
          value={
            <span
              className={
                mfa ? "text-emerald-700 font-medium" : "text-amber-600 font-medium"
              }
            >
              {mfa ? "Đã bật" : "Chưa bật"}
            </span>
          }
        />
        <SecurityRow
          icon={Monitor}
          label="Phiên đăng nhập"
          value={<span className="text-slate-400">Chưa hỗ trợ</span>}
        />
        <SecurityRow
          icon={Clock}
          label="Truy cập gần nhất"
          value={lastSignIn ? formatRelative(lastSignIn) : "Chưa có"}
        />
      </dl>
    </div>
  );
}

function SecurityRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-slate-500">{label}</dt>
        <dd className="text-sm text-slate-800 mt-0.5">{value}</dd>
      </div>
    </div>
  );
}

function NoticeCard() {
  return (
    <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Info className="h-4 w-4 text-amber-600" />
        <h3 className="text-sm font-semibold text-amber-800">Lưu ý</h3>
      </div>
      <p className="text-xs text-amber-800/80 leading-relaxed">
        Chỉ quản trị viên nền tảng mới có thể truy cập các tính năng hỗ trợ ở
        cấp tổ chức và nhật ký kiểm toán.
      </p>
    </div>
  );
}

/* ---------------- Stat card ---------------- */

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

/* ---------------- Time helpers ---------------- */

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString("vi-VN");
  const s = Math.floor(diff / 1000);
  if (s < 60) return "vừa xong";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    // "Hôm nay, HH:MM"
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `Hôm nay, ${hh}:${mm}`;
  }
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} ngày trước`;
  return new Date(iso).toLocaleDateString("vi-VN");
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("vi-VN");
}

/* ---------------- Add admin modal (giữ nguyên) ---------------- */

function AddAdminModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    user_id: "",
    role: "platform_support" as "platform_owner" | "platform_support",
    notes: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/platform/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Thêm lỗi");
      setLoading(false);
      return;
    }
    onSuccess();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">Thêm quản trị nền tảng</h3>
          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-lg hover:bg-slate-100"
          >
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Mã người dùng (UUID auth.users)
            </label>
            <input
              type="text"
              required
              value={form.user_id}
              onChange={(e) => setForm({ ...form, user_id: e.target.value })}
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
              placeholder="00000000-0000-0000-0000-000000000000"
            />
            <p className="text-xs text-slate-500 mt-1">
              Người dùng phải tồn tại trong auth.users. Truy vấn CSDL để lấy UUID.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Vai trò
            </label>
            <select
              value={form.role}
              onChange={(e) =>
                setForm({
                  ...form,
                  role: e.target.value as "platform_owner" | "platform_support",
                })
              }
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm bg-white"
            >
              <option value="platform_support">Hỗ trợ nền tảng</option>
              <option value="platform_owner">Chủ nền tảng</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Ghi chú (tuỳ chọn)
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm resize-none"
            />
          </div>
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-xl border border-slate-200 text-sm font-medium hover:bg-slate-50"
            >
              Huỷ
            </button>
            <button
              type="submit"
              disabled={loading}
              className="h-10 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Thêm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
