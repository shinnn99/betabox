"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Users,
  UserPlus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  X,
  Save,
  KeyRound,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useSession } from "@/lib/useSession";
import { ROLE_OPTIONS, ROLE_LABEL, type Role } from "@/lib/auth";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import { apiFetch, useImpersonatingOrgId } from "@/lib/api-fetch";

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: Role;
  status: string;
  created_at: string;
  linked_staff: { id: string; staff_code: string; full_name: string } | null;
}

export default function UsersPage() {
  const { session } = useSession();
  const impersonatingOrgId = useImpersonatingOrgId();
  const confirm = useConfirm();
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await apiFetch("/api/users", { cache: "no-store" }, impersonatingOrgId);
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được danh sách.");
      setLoading(false);
      return;
    }
    setUsers(data.users);
    setLoading(false);
  }, [impersonatingOrgId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = users.filter(
    (u) =>
      u.full_name.toLowerCase().includes(q.toLowerCase()) ||
      u.email.toLowerCase().includes(q.toLowerCase())
  );

  const onDelete = async (u: UserRow) => {
    const ok = await confirm({
      title: "Xoá tài khoản?",
      message: (
        <>
          Tài khoản <b>{u.email}</b> sẽ không đăng nhập được nữa. Thao tác này không thể hoàn tác.
        </>
      ),
      confirmLabel: "Xoá",
      variant: "danger",
    });
    if (!ok) return;
    const res = await apiFetch(`/api/users/${u.id}`, { method: "DELETE" }, impersonatingOrgId);
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Xoá thất bại");
      return;
    }
    toast.success(`Đã xoá ${u.email}`);
    load();
  };

  return (
    <DashboardLayout
      pageTitle="Người dùng hệ thống"
      pageSubtitle="Tài khoản truy cập web — kho có thể có nhiều người dùng theo phân quyền"
      pageIcon={Users}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 h-9 px-3 rounded-xl border border-slate-200 bg-slate-50/60 text-slate-500 flex-1 max-w-sm">
              <Search className="h-4 w-4" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Tìm tên hoặc email..."
                className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
              />
            </div>
            <div className="text-xs text-slate-500">
              Tổ chức: <b>{session?.organizationName ?? "..."}</b>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="ml-auto h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
            >
              <UserPlus className="h-4 w-4" /> Thêm người dùng
            </button>
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
              {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/60">
                <tr className="text-left text-[11px] tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-semibold">Họ tên</th>
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold">Vai trò</th>
                  <th className="px-4 py-3 font-semibold">SĐT</th>
                  <th className="px-4 py-3 font-semibold">NV kho liên kết</th>
                  <th className="px-4 py-3 font-semibold">Trạng thái</th>
                  <th className="px-4 py-3 font-semibold text-right w-32">
                    <span className="inline-block w-20 text-center">Hành động</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                      Đang tải...
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                      Chưa có người dùng nào.
                    </td>
                  </tr>
                )}
                {filtered.map((u) => {
                  return (
                    <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-800">{u.full_name}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-mono text-xs">{u.email}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 text-xs font-medium border border-violet-100">
                          {ROLE_LABEL[u.role] ?? u.role}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs">{u.phone ?? "—"}</td>
                      <td className="px-4 py-3 text-xs">
                        {u.linked_staff ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-100 font-medium">
                            <span className="font-mono">{u.linked_staff.staff_code}</span>
                            <span className="ml-1 text-slate-500">· {u.linked_staff.full_name}</span>
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs font-medium ${
                            u.status === "active" ? "text-emerald-600" : "text-slate-400"
                          }`}
                        >
                          {u.status === "active" ? "Hoạt động" : u.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center justify-center gap-1 w-20">
                          <button
                            onClick={() => setEditing(u)}
                            className="h-8 w-8 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-600"
                            title="Sửa"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => onDelete(u)}
                            disabled={u.id === session?.userId}
                            className="h-8 w-8 rounded-lg hover:bg-red-50 inline-flex items-center justify-center text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={u.id === session?.userId ? "Không thể xoá chính bạn" : "Xoá"}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateUserDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </DashboardLayout>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const impersonatingOrgId = useImpersonatingOrgId();
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    phone: "",
    role: "warehouse_manager" as Role,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    const res = await apiFetch(
      "/api/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      },
      impersonatingOrgId,
    );
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Tạo thất bại");
      return;
    }
    onCreated();
  };

  return (
    <Modal title="Thêm người dùng" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email">
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <Field label="Mật khẩu (≥ 8 ký tự)">
          <input
            type="text"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </Field>
        <Field label="Họ tên">
          <input
            required
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <Field label="Số điện thoại">
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <Field label="Vai trò">
          <Select
            value={form.role}
            onChange={(v) => setForm({ ...form, role: v as Role })}
            options={ROLE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
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
            Tạo
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const impersonatingOrgId = useImpersonatingOrgId();
  const [form, setForm] = useState({
    full_name: user.full_name,
    phone: user.phone ?? "",
    role: user.role,
    status: user.status,
    password: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const linked = !!user.linked_staff;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    const body: Record<string, unknown> = {
      role: form.role,
      status: form.status,
    };
    if (!linked) {
      body.full_name = form.full_name;
      body.phone = form.phone || null;
    }
    if (form.password) body.password = form.password;

    const res = await apiFetch(
      `/api/users/${user.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      impersonatingOrgId,
    );
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Cập nhật thất bại");
      return;
    }
    onSaved();
  };

  return (
    <Modal title={`Sửa: ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {linked && (
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs text-blue-700">
            User này đã liên kết với nhân viên kho{" "}
            <b className="font-mono">{user.linked_staff!.staff_code}</b> ·{" "}
            <b>{user.linked_staff!.full_name}</b>. Họ tên và SĐT được quản lý ở trang{" "}
            <b>Nhân sự kho</b>.
          </div>
        )}
        <Field label="Họ tên">
          <input
            required
            disabled={linked}
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm disabled:bg-slate-50"
          />
        </Field>
        <Field label="Số điện thoại">
          <input
            disabled={linked}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm disabled:bg-slate-50"
          />
        </Field>
        <Field label="Vai trò">
          <Select
            value={form.role}
            onChange={(v) => setForm({ ...form, role: v as Role })}
            options={ROLE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
          />
        </Field>
        <Field label="Trạng thái">
          <Select
            value={form.status}
            onChange={(v) => setForm({ ...form, status: v })}
            options={[
              { value: "active", label: "Hoạt động" },
              { value: "disabled", label: "Tạm khoá" },
            ]}
          />
        </Field>
        <Field label="Mật khẩu mới (để trống nếu không đổi)">
          <div className="relative">
            <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm font-mono"
              placeholder="≥ 8 ký tự"
            />
          </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 mb-1.5 block">{label}</label>
      {children}
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
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
