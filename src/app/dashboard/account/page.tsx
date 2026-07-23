"use client";

import { useEffect, useState } from "react";
import {
  User as UserIcon,
  KeyRound,
  Mail,
  Phone,
  Save,
  Eye,
  EyeOff,
  Calendar,
  Clock,
  Lock,
  Check,
  AlertCircle,
  Loader2,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { apiFetch } from "@/lib/api-fetch";
import { getInitials, ROLE_LABEL, type Role } from "@/lib/auth";

interface AccountMe {
  userId: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: Role | null;
  organizationId: string;
  createdAt: string | null;
  lastSignInAt: string | null;
  linkedToStaff: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "Vừa xong";
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} ngày trước`;
  return d.toLocaleDateString("vi-VN");
}

export default function AccountPage() {
  const [me, setMe] = useState<AccountMe | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/account/me", { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as AccountMe;
        if (cancelled) return;
        setMe(data);
        setFullName(data.fullName ?? "");
        setPhone(data.phone ?? "");
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoadingMe(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setProfileMsg(null);
    setSavingProfile(true);
    try {
      const res = await apiFetch("/api/account/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          full_name: fullName,
          phone: phone.trim() === "" ? null : phone,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      setProfileMsg({ type: "ok", text: "Đã cập nhật thông tin cá nhân." });
      setMe({ ...me, fullName, phone: phone.trim() === "" ? null : phone });
    } catch (e) {
      setProfileMsg({ type: "err", text: (e as Error).message });
    } finally {
      setSavingProfile(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);

    if (newPw !== confirmPw) {
      setPwMsg({ type: "err", text: "Xác nhận mật khẩu mới không khớp." });
      return;
    }
    if (newPw.length < 8) {
      setPwMsg({ type: "err", text: "Mật khẩu mới cần tối thiểu 8 ký tự." });
      return;
    }
    if (!/[A-Za-z]/.test(newPw) || !/\d/.test(newPw)) {
      setPwMsg({ type: "err", text: "Mật khẩu mới cần gồm cả chữ và số." });
      return;
    }

    setSavingPw(true);
    try {
      const res = await apiFetch("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      setPwMsg({ type: "ok", text: "Đã đổi mật khẩu thành công." });
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (e) {
      setPwMsg({ type: "err", text: (e as Error).message });
    } finally {
      setSavingPw(false);
    }
  }

  const roleLabel = me?.role ? ROLE_LABEL[me.role] ?? me.role : "";
  const linked = me?.linkedToStaff ?? false;
  const initials = me ? getInitials(me.fullName || me.email) : "?";

  return (
    <DashboardLayout
      pageTitle="Tài khoản của tôi"
      pageSubtitle="Thông tin cá nhân & mật khẩu đăng nhập"
      pageIcon={UserIcon}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Card trái: profile snapshot */}
        <div className="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm text-center">
          <div className="mx-auto h-20 w-20 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl font-bold border-4 border-emerald-100">
            {initials}
          </div>
          <p className="mt-3 font-bold text-slate-800">
            {loadingMe ? "Đang tải…" : me?.fullName || me?.email || "—"}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">{roleLabel}</p>

          <div className="mt-4 space-y-2 text-left">
            <div className="rounded-lg bg-slate-50 p-2.5 flex items-start gap-2">
              <Calendar className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Tham gia từ</p>
                <p className="text-sm font-semibold text-slate-800">{formatDate(me?.createdAt ?? null)}</p>
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-2.5 flex items-start gap-2">
              <Clock className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Đăng nhập gần nhất</p>
                <p className="text-sm font-semibold text-slate-800">{formatRelative(me?.lastSignInAt ?? null)}</p>
              </div>
            </div>
          </div>

          {linked && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-left">
              <p className="text-[11px] text-amber-800 leading-snug">
                Tài khoản này liên kết với một nhân viên kho. Họ tên và SĐT chỉ sửa được ở trang Nhân sự kho.
              </p>
            </div>
          )}
        </div>

        {/* Cột phải: 2 form */}
        <div className="lg:col-span-2 space-y-3">
          {/* Form profile */}
          <form onSubmit={submitProfile} className="bg-white rounded-2xl border border-slate-100 shadow-sm">
            <div className="p-5 border-b border-slate-100">
              <p className="font-bold text-slate-800">Thông tin cá nhân</p>
              <p className="text-xs text-slate-500">
                Thông tin liên hệ sử dụng cho thông báo hệ thống.
              </p>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Họ và tên
                </label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={loadingMe || linked}
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10 disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block flex items-center gap-1.5">
                  Email
                  <Lock className="h-3 w-3 text-slate-400" />
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    value={me?.email ?? ""}
                    disabled
                    readOnly
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-500"
                  />
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Email không thể tự đổi. Liên hệ quản trị viên nếu cần thay đổi.
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Số điện thoại
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    disabled={loadingMe || linked}
                    placeholder="VD: 0912345678"
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10 disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block flex items-center gap-1.5">
                  Vai trò
                  <Lock className="h-3 w-3 text-slate-400" />
                </label>
                <input
                  value={roleLabel}
                  disabled
                  readOnly
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-500"
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 flex items-center justify-between gap-3">
              <div className="text-sm min-h-[20px]">
                {loadError && (
                  <span className="inline-flex items-center gap-1.5 text-rose-600">
                    <AlertCircle className="h-4 w-4" /> {loadError}
                  </span>
                )}
                {profileMsg?.type === "ok" && (
                  <span className="inline-flex items-center gap-1.5 text-emerald-600">
                    <Check className="h-4 w-4" /> {profileMsg.text}
                  </span>
                )}
                {profileMsg?.type === "err" && (
                  <span className="inline-flex items-center gap-1.5 text-rose-600">
                    <AlertCircle className="h-4 w-4" /> {profileMsg.text}
                  </span>
                )}
              </div>
              <button
                type="submit"
                disabled={loadingMe || linked || savingProfile}
                className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-300 text-white text-sm font-semibold inline-flex items-center gap-2"
              >
                {savingProfile ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Cập nhật
              </button>
            </div>
          </form>

          {/* Form đổi mật khẩu */}
          <form onSubmit={submitPassword} className="bg-white rounded-2xl border border-slate-100 shadow-sm">
            <div className="p-5 border-b border-slate-100">
              <p className="font-bold text-slate-800">Đổi mật khẩu</p>
              <p className="text-xs text-slate-500">
                Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.
              </p>
            </div>
            <div className="p-5 space-y-4 max-w-md">
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Mật khẩu hiện tại
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type={showOld ? "text" : "password"}
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    autoComplete="current-password"
                    className="w-full h-10 pl-9 pr-10 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOld((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showOld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Mật khẩu mới
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    autoComplete="new-password"
                    className="w-full h-10 pl-9 pr-10 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Nhập lại mật khẩu mới
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type={showNew ? "text" : "password"}
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    autoComplete="new-password"
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex items-center justify-between gap-3">
              <div className="text-sm min-h-[20px]">
                {pwMsg?.type === "ok" && (
                  <span className="inline-flex items-center gap-1.5 text-emerald-600">
                    <Check className="h-4 w-4" /> {pwMsg.text}
                  </span>
                )}
                {pwMsg?.type === "err" && (
                  <span className="inline-flex items-center gap-1.5 text-rose-600">
                    <AlertCircle className="h-4 w-4" /> {pwMsg.text}
                  </span>
                )}
              </div>
              <button
                type="submit"
                disabled={savingPw || !oldPw || !newPw || !confirmPw}
                className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-300 text-white text-sm font-semibold inline-flex items-center gap-2"
              >
                {savingPw ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Đổi mật khẩu
              </button>
            </div>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
