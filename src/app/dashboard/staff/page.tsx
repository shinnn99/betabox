"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import QRCode from "qrcode";
import {
  Users,
  UserPlus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  X,
  Save,
  QrCode as QrCodeIcon,
  RefreshCcw,
  Download,
  Printer,
  Link2,
  LinkIcon,
  Unlink,
  Mail,
} from "lucide-react";
import { ROLE_OPTIONS, ROLE_LABEL, type Role } from "@/lib/auth";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";

function useQrDataUrl(payload: string | null, size: number) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 1, width: size })
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch((e) => {
        console.error("[useQrDataUrl] render failed:", e, "payload=", payload);
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payload, size]);
  return url;
}

type StaffStatus = "active" | "inactive" | "on_leave";

interface AssignmentRef {
  warehouse_id: string;
  code: string;
  name: string;
  is_primary: boolean;
}

interface StaffRow {
  id: string;
  staff_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  status: StaffStatus;
  user_id: string | null;
  note: string | null;
  created_at: string;
  warehouses: AssignmentRef[];
  qr_active_prefix: string | null;
  qr_payload: string | null;
}

interface LinkableUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
}

interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

const STATUS_LABEL: Record<StaffStatus, string> = {
  active: "Đang làm",
  inactive: "Nghỉ việc",
  on_leave: "Nghỉ phép",
};

const STATUS_COLOR: Record<StaffStatus, string> = {
  active: "text-emerald-600",
  inactive: "text-slate-400",
  on_leave: "text-amber-600",
};

export default function StaffPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [qrFor, setQrFor] = useState<StaffRow | null>(null);
  const [linkFor, setLinkFor] = useState<StaffRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [resStaff, resW] = await Promise.all([
      fetch("/api/staff", { cache: "no-store" }),
      fetch("/api/warehouses", { cache: "no-store" }),
    ]);
    const dataStaff = await resStaff.json();
    const dataW = await resW.json();
    if (!resStaff.ok) {
      setError(dataStaff.message ?? dataStaff.error ?? "Không tải được nhân sự.");
      setLoading(false);
      return;
    }
    setStaff(dataStaff.staff);
    setWarehouses(resW.ok ? dataW.warehouses : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = staff.filter(
    (s) =>
      s.full_name.toLowerCase().includes(q.toLowerCase()) ||
      s.staff_code.toLowerCase().includes(q.toLowerCase()) ||
      (s.phone ?? "").includes(q)
  );

  const onDelete = async (s: StaffRow) => {
    const ok = await confirm({
      title: "Xoá nhân viên?",
      message: (
        <>
          Bạn có chắc muốn xoá <b>{s.staff_code}</b> — {s.full_name}? Thao tác này không thể hoàn tác.
        </>
      ),
      confirmLabel: "Xoá",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/staff/${s.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Xoá thất bại");
      return;
    }
    toast.success(`Đã xoá ${s.staff_code}`);
    load();
  };

  return (
    <DashboardLayout
      pageTitle="Nhân sự kho"
      pageSubtitle="Nhân viên đóng hàng — có hoặc không có tài khoản đăng nhập, gắn QR vào ca"
      pageIcon={Users}
    >
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 h-9 px-3 rounded-xl border border-slate-200 bg-slate-50/60 text-slate-500 flex-1 max-w-sm">
            <Search className="h-4 w-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm mã NV, họ tên, SĐT..."
              className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
            />
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="ml-auto h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
          >
            <UserPlus className="h-4 w-4" /> Thêm nhân viên
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
                <th className="px-4 py-3 font-semibold">Mã NV</th>
                <th className="px-4 py-3 font-semibold">Họ tên</th>
                <th className="px-4 py-3 font-semibold">SĐT</th>
                <th className="px-4 py-3 font-semibold">Kho làm việc</th>
                <th className="px-4 py-3 font-semibold">Tài khoản web</th>
                <th className="px-4 py-3 font-semibold">QR</th>
                <th className="px-4 py-3 font-semibold">Trạng thái</th>
                <th className="px-4 py-3 font-semibold text-right w-40">
                  <span className="inline-block w-28 text-center">Hành động</span>
                </th>
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
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                    Chưa có nhân viên nào.
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                return (
                  <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-mono font-semibold text-slate-800">
                      {s.staff_code}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{s.full_name}</p>
                      {s.email && (
                        <p className="text-[11px] text-slate-400 font-mono">{s.email}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600 text-xs">{s.phone ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {s.warehouses.length === 0 && (
                          <span className="text-xs text-slate-400">Chưa gán</span>
                        )}
                        {s.warehouses.map((w) => (
                          <span
                            key={w.warehouse_id}
                            className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${
                              w.is_primary
                                ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                : "bg-slate-50 text-slate-600 border-slate-200"
                            }`}
                          >
                            {w.code}
                            {w.is_primary && <span className="ml-1">★</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {s.user_id ? (
                        <span className="inline-flex items-center gap-1 text-xs text-blue-600 font-medium">
                          <LinkIcon className="h-3 w-3" /> Đã liên kết
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <QrThumb staff={s} onClick={() => setQrFor(s)} />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${STATUS_COLOR[s.status]}`}>
                        {STATUS_LABEL[s.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center justify-center gap-1 w-28">
                        <button
                          onClick={() => setLinkFor(s)}
                          className="h-8 w-8 rounded-lg hover:bg-blue-50 inline-flex items-center justify-center text-blue-600"
                          title="Liên kết tài khoản web"
                        >
                          <Link2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setEditing(s)}
                          className="h-8 w-8 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-600"
                          title="Sửa"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onDelete(s)}
                          className="h-8 w-8 rounded-lg hover:bg-red-50 inline-flex items-center justify-center text-red-600"
                          title="Xoá"
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

      {showCreate && (
        <StaffDialog
          mode="create"
          warehouses={warehouses}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editing && (
        <StaffDialog
          mode="edit"
          warehouses={warehouses}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {qrFor && (
        <QrDialog
          staff={qrFor}
          onClose={() => {
            setQrFor(null);
            load();
          }}
        />
      )}
      {linkFor && (
        <LinkUserDialog
          staff={linkFor}
          onClose={() => {
            setLinkFor(null);
            load();
          }}
        />
      )}
    </DashboardLayout>
  );
}

function StaffDialog({
  mode,
  initial,
  warehouses,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: StaffRow;
  warehouses: WarehouseOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialWarehouseIds = initial?.warehouses.map((w) => w.warehouse_id) ?? [];
  const initialPrimary = initial?.warehouses.find((w) => w.is_primary)?.warehouse_id ?? null;

  const [form, setForm] = useState({
    staff_code: initial?.staff_code ?? "",
    full_name: initial?.full_name ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    status: (initial?.status ?? "active") as StaffStatus,
    note: initial?.note ?? "",
  });
  const [warehouseIds, setWarehouseIds] = useState<string[]>(initialWarehouseIds);
  const [primaryId, setPrimaryId] = useState<string | null>(initialPrimary);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const toggleWh = (id: string) => {
    setWarehouseIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (primaryId && !next.includes(primaryId)) setPrimaryId(next[0] ?? null);
      if (!primaryId && next.length > 0) setPrimaryId(next[0]);
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    const body = {
      ...form,
      warehouse_ids: warehouseIds,
      primary_warehouse_id: primaryId,
    };
    const url = mode === "create" ? "/api/staff" : `/api/staff/${initial!.id}`;
    const method = mode === "create" ? "POST" : "PATCH";
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
    <Modal
      title={mode === "create" ? "Thêm nhân viên kho" : `Sửa: ${initial?.staff_code}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mã nhân viên" required>
            <input
              required
              value={form.staff_code}
              onChange={(e) => setForm({ ...form, staff_code: e.target.value })}
              placeholder="NV001"
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono uppercase"
              disabled={mode === "edit"}
            />
          </Field>
          <Field label="Trạng thái">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v as StaffStatus })}
              options={[
                { value: "active", label: "Đang làm" },
                { value: "on_leave", label: "Nghỉ phép" },
                { value: "inactive", label: "Nghỉ việc" },
              ]}
            />
          </Field>
        </div>
        <Field label="Họ và tên" required>
          <input
            required
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Số điện thoại">
            <input
              value={form.phone ?? ""}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={form.email ?? ""}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
            />
          </Field>
        </div>
        <Field label="Kho làm việc">
          {warehouses.length === 0 ? (
            <p className="text-xs text-slate-400 italic">
              Chưa có kho nào — tạo kho ở trang &quot;Kho hàng&quot; trước.
            </p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto border border-slate-200 rounded-xl p-2">
              {warehouses.map((w) => {
                const checked = warehouseIds.includes(w.id);
                return (
                  <label
                    key={w.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleWh(w.id)}
                      className="h-4 w-4"
                    />
                    <span className="font-mono text-xs text-slate-500 w-12">{w.code}</span>
                    <span className="flex-1 text-slate-800">{w.name}</span>
                    {checked && (
                      <button
                        type="button"
                        onClick={() => setPrimaryId(w.id)}
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          primaryId === w.id
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-500 hover:bg-emerald-50"
                        }`}
                        title="Đặt làm kho chính"
                      >
                        {primaryId === w.id ? "★ Chính" : "Đặt chính"}
                      </button>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </Field>
        <Field label="Ghi chú">
          <textarea
            value={form.note ?? ""}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            rows={2}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
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

function LinkUserDialog({
  staff,
  onClose,
}: {
  staff: StaffRow;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [mode, setMode] = useState<"choose" | "link" | "invite">("choose");
  const [linkable, setLinkable] = useState<LinkableUser[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [inviteForm, setInviteForm] = useState({
    email: staff.email ?? "",
    password: "",
    role: "packer" as Role,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const loadLinkable = useCallback(async () => {
    setLoadingList(true);
    const res = await fetch(`/api/staff/linkable-users?include_staff_id=${staff.id}`, {
      cache: "no-store",
    });
    const data = await res.json();
    setLoadingList(false);
    if (res.ok) setLinkable(data.users);
  }, [staff.id]);

  useEffect(() => {
    if (mode === "link") loadLinkable();
  }, [mode, loadLinkable]);

  const doLink = async () => {
    if (!selectedUserId) return;
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/staff/${staff.id}/link-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: selectedUserId }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Liên kết thất bại");
      return;
    }
    onClose();
  };

  const doUnlink = async () => {
    const ok = await confirm({
      title: "Gỡ liên kết tài khoản?",
      message: "Tài khoản web sẽ không còn gắn với nhân viên này. QR điểm danh và dữ liệu ca làm vẫn giữ.",
      confirmLabel: "Gỡ liên kết",
      variant: "warning",
    });
    if (!ok) return;
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/staff/${staff.id}/link-user`, { method: "DELETE" });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Gỡ liên kết thất bại");
      return;
    }
    onClose();
  };

  const doInvite = async () => {
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/staff/${staff.id}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inviteForm),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Tạo tài khoản thất bại");
      return;
    }
    onClose();
  };

  // Đã có link
  if (staff.user_id) {
    return (
      <Modal title={`Tài khoản web: ${staff.full_name}`} onClose={onClose}>
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4">
            <p className="text-sm font-medium text-emerald-700 inline-flex items-center gap-2">
              <LinkIcon className="h-4 w-4" /> Đã liên kết tài khoản đăng nhập
            </p>
            <p className="text-xs text-slate-600 mt-1">
              Nhân viên này có thể đăng nhập web. Để đổi quyền hoặc đổi email, vào trang &quot;Người
              dùng hệ thống&quot;.
            </p>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={doUnlink}
              disabled={saving}
              className="h-9 px-4 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
              Gỡ liên kết
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Choose mode
  if (mode === "choose") {
    return (
      <Modal title={`Tài khoản web: ${staff.full_name}`} onClose={onClose}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Nhân viên <b>{staff.staff_code}</b> chưa có tài khoản đăng nhập web.
          </p>
          <button
            type="button"
            onClick={() => setMode("link")}
            className="w-full text-left p-4 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition"
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <LinkIcon className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-slate-800">Liên kết với user có sẵn</p>
                <p className="text-xs text-slate-500">
                  Chọn từ danh sách người dùng đã có trong tổ chức nhưng chưa gán nhân viên.
                </p>
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode("invite")}
            className="w-full text-left p-4 rounded-xl border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/30 transition"
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <Mail className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-slate-800">Tạo tài khoản web mới</p>
                <p className="text-xs text-slate-500">
                  Tạo user đăng nhập (email + mật khẩu + vai trò) và tự liên kết.
                </p>
              </div>
            </div>
          </button>
        </div>
      </Modal>
    );
  }

  // Link existing
  if (mode === "link") {
    return (
      <Modal title="Liên kết user có sẵn" onClose={onClose}>
        <div className="space-y-3">
          {loadingList ? (
            <div className="py-6 text-center text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
            </div>
          ) : linkable.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">
              Không có user nào khả dụng. Mọi user đã được gán hoặc tổ chức chưa có user phù hợp.
            </p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto border border-slate-200 rounded-xl p-1">
              {linkable.map((u) => (
                <label
                  key={u.id}
                  className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-sm ${
                    selectedUserId === u.id ? "bg-blue-50" : "hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="user"
                    checked={selectedUserId === u.id}
                    onChange={() => setSelectedUserId(u.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800 truncate">{u.full_name}</p>
                    <p className="text-[11px] text-slate-500 font-mono truncate">{u.email}</p>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 font-medium">
                    {ROLE_LABEL[u.role as Role] ?? u.role}
                  </span>
                </label>
              ))}
            </div>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={() => setMode("choose")}
              className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
            >
              ← Quay lại
            </button>
            <button
              type="button"
              onClick={doLink}
              disabled={!selectedUserId || saving}
              className="h-9 px-4 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <LinkIcon className="h-4 w-4" />}
              Liên kết
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // Invite (create + link)
  return (
    <Modal title="Tạo tài khoản web mới" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-slate-50 rounded-xl p-3 text-xs text-slate-600">
          Họ tên và SĐT sẽ lấy từ hồ sơ nhân viên: <b>{staff.full_name}</b>
          {staff.phone ? ` · ${staff.phone}` : ""}
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
            Email <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            required
            value={inviteForm.email}
            onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
            placeholder="nv001@congty.vn"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
            Mật khẩu (≥ 8 ký tự) <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            required
            minLength={8}
            value={inviteForm.password}
            onChange={(e) => setInviteForm({ ...inviteForm, password: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
            Vai trò
          </label>
          <Select
            value={inviteForm.role}
            onChange={(v) => setInviteForm({ ...inviteForm, role: v as Role })}
            options={ROLE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
          />
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
          >
            ← Quay lại
          </button>
          <button
            type="button"
            onClick={doInvite}
            disabled={saving || !inviteForm.email || inviteForm.password.length < 8}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            Tạo & Liên kết
          </button>
        </div>
      </div>
    </Modal>
  );
}

function QrThumb({ staff, onClick }: { staff: StaffRow; onClick: () => void }) {
  const url = useQrDataUrl(staff.qr_payload, 96);
  if (!staff.qr_payload) {
    return (
      <button
        onClick={onClick}
        className="text-xs text-slate-400 hover:text-violet-600 inline-flex items-center gap-1"
        title="Chưa có QR — bấm để cấp"
      >
        <QrCodeIcon className="h-3.5 w-3.5" /> Chưa cấp
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="h-12 w-12 rounded-md border border-slate-200 hover:border-violet-300 hover:ring-2 hover:ring-violet-100 transition overflow-hidden bg-white"
      title="Bấm để phóng to & lưu"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`QR ${staff.staff_code}`} className="h-full w-full object-contain" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-slate-400 mx-auto" />
      )}
    </button>
  );
}

function QrDialog({ staff, onClose }: { staff: StaffRow; onClose: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [payload, setPayload] = useState<string | null>(staff.qr_payload);
  const [prefix, setPrefix] = useState<string | null>(staff.qr_active_prefix);
  const [regenerating, setRegenerating] = useState(false);
  const [err, setErr] = useState("");
  const bigUrl = useQrDataUrl(payload, 320);

  const filename = useMemo(() => `qr-${staff.staff_code}.png`, [staff.staff_code]);

  const composeCanvas = (): Promise<HTMLCanvasElement | null> => {
    return new Promise((resolve) => {
      if (!bigUrl) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const size = 480;
        const padding = 24;
        const qrSize = 360;
        const textBlockHeight = 80;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = qrSize + padding * 2 + textBlockHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const qrX = (size - qrSize) / 2;
        ctx.drawImage(img, qrX, padding, qrSize, qrSize);
        ctx.fillStyle = "#0f172a";
        ctx.textAlign = "center";
        ctx.font = "bold 22px sans-serif";
        ctx.fillText(staff.full_name, size / 2, qrSize + padding + 36);
        ctx.fillStyle = "#475569";
        ctx.font = "16px monospace";
        ctx.fillText(staff.staff_code, size / 2, qrSize + padding + 62);
        resolve(canvas);
      };
      img.onerror = () => resolve(null);
      img.src = bigUrl;
    });
  };

  const download = async () => {
    const canvas = await composeCanvas();
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = filename;
    a.click();
  };

  const print = async () => {
    const canvas = await composeCanvas();
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    const win = window.open("", "_blank", "width=480,height=640");
    if (!win) return;
    win.document.write(`
      <html><head><title>QR ${staff.staff_code}</title>
      <style>body{margin:0;padding:24px;text-align:center}</style>
      </head><body>
        <img src="${dataUrl}" style="max-width:100%;height:auto"/>
        <script>window.onload=()=>window.print()</script>
      </body></html>
    `);
    win.document.close();
  };

  const regenerate = async () => {
    if (prefix) {
      const ok = await confirm({
        title: "Cấp QR mới?",
        message: (
          <>
            QR hiện tại (prefix <span className="font-mono">{prefix}…</span>) sẽ bị huỷ ngay. QR đã in/dán sẽ không quét được nữa.
          </>
        ),
        confirmLabel: "Cấp QR mới",
        variant: "warning",
      });
      if (!ok) return;
    }
    setRegenerating(true);
    setErr("");
    const res = await fetch(`/api/staff/${staff.id}/qr`, { method: "POST" });
    const data = await res.json();
    setRegenerating(false);
    if (!res.ok) {
      const msg = data.message ?? data.error ?? "Cấp QR thất bại";
      setErr(msg);
      toast.error(msg);
      return;
    }
    setPayload(data.payload);
    setPrefix(data.token_prefix);
    toast.success("Đã cấp QR mới");
  };

  return (
    <Modal title="QR nhân sự kho" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 p-4 border border-emerald-100 bg-emerald-50/30 rounded-xl">
          {payload === null ? (
            <div className="w-64 h-64 flex flex-col items-center justify-center text-center px-4 gap-2">
              <QrCodeIcon className="h-10 w-10 text-slate-300" />
              <p className="text-sm text-slate-500">
                QR này được cấp trước khi hệ thống lưu lại payload.
              </p>
              <p className="text-xs text-slate-400">Bấm &quot;Cấp lại&quot; bên dưới để tạo QR mới.</p>
            </div>
          ) : bigUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bigUrl} alt="QR" className="w-64 h-64" />
          ) : (
            <div className="w-64 h-64 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          )}
          <p className="text-sm text-slate-700 text-center">
            <span className="font-mono font-semibold">{staff.staff_code}</span>
            <span className="text-slate-400"> — </span>
            <span className="font-semibold">{staff.full_name}</span>
          </p>
        </div>
        <div className="flex gap-2">
          {payload === null ? (
            <button
              onClick={regenerate}
              disabled={regenerating}
              className="flex-1 h-10 rounded-xl bg-violet-500 hover:bg-violet-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {regenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              {prefix ? "Cấp lại QR" : "Cấp QR"}
            </button>
          ) : (
            <>
              <button
                onClick={download}
                disabled={!bigUrl}
                className="flex-1 h-10 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <Download className="h-4 w-4" /> Lưu
              </button>
              <button
                onClick={print}
                disabled={!bigUrl}
                className="flex-1 h-10 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <Printer className="h-4 w-4" /> In
              </button>
              <button
                onClick={regenerate}
                disabled={regenerating}
                className="h-10 px-3 rounded-xl border border-slate-200 hover:bg-violet-50 text-violet-600 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
                title="Cấp QR mới (huỷ QR cũ)"
              >
                {regenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4" />
                )}
              </button>
            </>
          )}
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
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
