"use client";

import { useState } from "react";
import { User as UserIcon, KeyRound, Mail, Phone, Save, Eye, EyeOff } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useSession } from "@/lib/useSession";
import { getInitials } from "@/lib/auth";

export default function AccountPage() {
  const { session } = useSession();
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);

  return (
    <DashboardLayout
      pageTitle="Tài khoản của tôi"
      pageSubtitle="Thông tin cá nhân & mật khẩu đăng nhập"
      pageIcon={UserIcon}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm text-center">
          <div className="mx-auto h-20 w-20 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl font-bold border-4 border-emerald-100">
            {session ? getInitials(session.fullName) : "?"}
          </div>
          <p className="mt-3 font-bold text-slate-800">{session?.fullName ?? "..."}</p>
          <p className="text-xs text-slate-500">
            {session?.roleLabel ?? "..."} · {session?.organizationName ?? ""}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 text-left">
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-[10px] text-slate-500 uppercase">Đơn đã giám sát</p>
              <p className="text-sm font-bold text-slate-800 font-mono">12.487</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-[10px] text-slate-500 uppercase">Khiếu nại xử lý</p>
              <p className="text-sm font-bold text-slate-800 font-mono">203</p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-3">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
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
                    key={`name-${session?.userId ?? "x"}`}
                    defaultValue={session?.fullName ?? ""}
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    key={`email-${session?.userId ?? "x"}`}
                    defaultValue={session?.email ?? ""}
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Số điện thoại
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    key={`phone-${session?.userId ?? "x"}`}
                    defaultValue={session?.phone ?? ""}
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/10"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  Vai trò
                </label>
                <input
                  disabled
                  key={`role-${session?.userId ?? "x"}`}
                  defaultValue={session?.roleLabel ?? ""}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-500"
                />
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex items-center justify-end">
              <button className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2">
                <Save className="h-4 w-4" /> Cập nhật
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
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
                    className="w-full h-10 pl-9 pr-10 rounded-xl border border-slate-200 text-sm"
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
                    className="w-full h-10 pl-9 pr-10 rounded-xl border border-slate-200 text-sm"
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
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 text-sm"
                  />
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex items-center justify-end">
              <button className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2">
                <Save className="h-4 w-4" /> Đổi mật khẩu
              </button>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
