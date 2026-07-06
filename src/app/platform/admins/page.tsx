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
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";
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
}

export default function PlatformAdminsPage() {
  const { session } = usePlatformSession();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);

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

  return (
    <PlatformLayout
      pageTitle="Quản trị nền tảng"
      pageSubtitle="Người có quyền truy cập tầng quản trị của hệ thống"
      pageIcon={Users}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
            <div className="text-xs text-slate-500">
              Tổng: <b>{admins.length}</b>
            </div>
            {isOwner && (
              <button
                onClick={() => setShowAdd(true)}
                className="ml-auto h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
              >
                <UserPlus className="h-4 w-4" /> Thêm quản trị
              </button>
            )}
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
              {error}
            </div>
          )}

          {loading ? (
            <div className="p-8 flex items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
              Đang tải...
            </div>
          ) : admins.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có quản trị nền tảng nào.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {admins.map((a) => {
                const isSelf = a.id === session?.userId;
                const RoleIcon = a.role === "platform_owner" ? ShieldCheck : Shield;
                const roleLabel =
                  a.role === "platform_owner" ? "Chủ nền tảng" : "Hỗ trợ nền tảng";
                const roleColor =
                  a.role === "platform_owner"
                    ? "text-emerald-700 bg-emerald-50"
                    : "text-slate-600 bg-slate-100";
                return (
                  <div
                    key={a.id}
                    className="p-4 flex items-center gap-4 hover:bg-slate-50/50"
                  >
                    <div
                      className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${roleColor}`}
                    >
                      <RoleIcon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-800 truncate">
                          {a.email}
                        </p>
                        {isSelf && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
                            BẠN
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">
                        <span className={`font-semibold ${roleColor.split(" ")[0]}`}>
                          {roleLabel}
                        </span>
                        {a.created_by_email && (
                          <> · Được thêm bởi {a.created_by_email}</>
                        )}
                        {" · "}
                        {new Date(a.created_at).toLocaleDateString("vi-VN")}
                      </p>
                      {a.notes && (
                        <p className="text-xs text-slate-400 mt-1 italic truncate">
                          {a.notes}
                        </p>
                      )}
                    </div>
                    {isOwner && !isSelf && (
                      <button
                        onClick={() => onRevoke(a)}
                        className="h-9 w-9 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 flex items-center justify-center"
                        title="Xóa quyền"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showAdd && <AddAdminModal onClose={() => setShowAdd(false)} onSuccess={load} />}
    </PlatformLayout>
  );
}

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
