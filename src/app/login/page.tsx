"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  Video,
  Activity,
  PackageCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Vui lòng nhập đầy đủ email và mật khẩu.");
      return;
    }

    setLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError(
        signInError.message === "Invalid login credentials"
          ? "Email hoặc mật khẩu không đúng."
          : signInError.message
      );
      setLoading(false);
      return;
    }

    setSuccess(true);
    router.replace("/dashboard");
    router.refresh();
  };

  return (
    <div className="h-screen flex w-full overflow-hidden bg-gradient-to-br from-emerald-50/30 via-white to-green-50/30">
      <div className="hidden lg:flex lg:w-[55%] relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-950 via-emerald-900 to-green-950" />

        <div
          className="absolute inset-0 opacity-40"
          style={{
            background:
              "radial-gradient(ellipse at 20% 50%, rgba(16, 185, 129, 0.3) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(52, 211, 153, 0.25) 0%, transparent 50%), radial-gradient(ellipse at 40% 80%, rgba(5, 150, 105, 0.2) 0%, transparent 50%)",
          }}
        />

        <div
          className="absolute top-20 right-20 w-72 h-72 rounded-full border-2 border-white/[0.15] animate-pulse"
          style={{ animationDuration: "4s" }}
        />
        <div className="absolute top-32 right-32 w-48 h-48 rounded-full border-2 border-white/[0.1]" />
        <div className="absolute -bottom-16 -left-16 w-64 h-64 rounded-full bg-emerald-500/[0.08] blur-2xl" />
        <div className="absolute top-1/2 right-0 w-96 h-96 rounded-full bg-green-500/[0.06] blur-3xl -translate-y-1/2" />

        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />

        <div className="relative z-10 flex flex-col justify-between p-12 pb-6 xl:p-16 xl:pb-8 h-full w-full text-white">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center">
              <Video className="w-6 h-6 text-emerald-300" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-wide text-white/90">
                Betacom Camera
              </p>
              <p className="text-xs text-emerald-300/70">
                Warehouse Packing Monitor
              </p>
            </div>
          </div>

          <div className="max-w-lg -mt-8">
            <div className="mb-5">
              <p className="text-4xl xl:text-5xl font-extrabold tracking-tight pb-3">
                Giám sát đóng hàng
              </p>
              <p className="text-4xl xl:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-emerald-300 via-green-300 to-emerald-400 bg-clip-text text-transparent pb-1">
                Minh bạch & Hiệu suất
              </p>
            </div>
            <p className="text-emerald-200/80 text-base xl:text-lg leading-relaxed max-w-md">
              Quay video toàn bộ quá trình đóng hàng tại kho, đo lường hiệu
              suất nhân sự và truy xuất nhanh khi có khiếu nại từ khách hàng.
            </p>

            <div className="mt-10 flex flex-col gap-4">
              {[
                {
                  icon: Video,
                  title: "Quay video đóng hàng tự động",
                  desc: "Gắn camera theo đơn — lưu trữ theo mã vận đơn",
                },
                {
                  icon: Activity,
                  title: "Hiệu suất nhân sự theo ca",
                  desc: "Đơn/giờ, thời gian xử lý, sai sót",
                },
                {
                  icon: PackageCheck,
                  title: "Truy xuất & đối soát khiếu nại",
                  desc: "Tìm video theo mã đơn trong vài giây",
                },
              ].map(({ icon: Icon, title, desc }) => (
                <div
                  key={title}
                  className="flex items-center gap-5 p-4 rounded-2xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.07] transition-colors"
                >
                  <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                    <Icon className="w-7 h-7 text-emerald-300" />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-white/90">
                      {title}
                    </p>
                    <p className="text-sm text-emerald-300/60">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs text-emerald-400/50">
            &copy; {new Date().getFullYear()} Betacom JSC. All rights reserved.
          </div>
        </div>
      </div>

      <div className="w-full lg:w-[45%] flex items-center justify-center px-6 py-6 sm:p-12 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-100/40 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-green-100/30 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2 pointer-events-none" />

        <div className="w-full max-w-[420px] relative">
          <div className="mb-8 lg:hidden flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Video className="w-6 h-6 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">
                Betacom Camera
              </p>
              <p className="text-xs text-slate-500">
                Warehouse Packing Monitor
              </p>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-2 tracking-tight">
              Đăng nhập hệ thống
            </h2>
            <p className="text-slate-500 text-sm">
              Truy cập bảng giám sát camera đóng hàng tại kho.
            </p>
          </div>

          {error && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
                <span className="text-red-700 text-lg font-bold">!</span>
              </div>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="mb-5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
              <span>Đăng nhập thành công! Đang chuyển hướng...</span>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100/80 p-7 sm:p-8 space-y-5"
          >
            <div className="space-y-2">
              <label
                className="text-sm font-medium text-slate-700 block"
                htmlFor="email"
              >
                Tài khoản
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <Mail className="h-[18px] w-[18px] text-slate-400 group-focus-within:text-emerald-500 transition-colors" />
                </div>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-800 bg-slate-50/50 placeholder:text-slate-400 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10 focus:outline-none transition-all"
                  placeholder="admin@betacom.vn"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                className="text-sm font-medium text-slate-700 block"
                htmlFor="password"
              >
                Mật khẩu
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <Lock className="h-[18px] w-[18px] text-slate-400 group-focus-within:text-emerald-500 transition-colors" />
                </div>
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="block w-full pl-11 pr-11 py-3 border border-slate-200 rounded-xl text-sm text-slate-800 bg-slate-50/50 placeholder:text-slate-400 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10 focus:outline-none transition-all"
                  placeholder="Nhập mật khẩu"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                >
                  {showPassword ? (
                    <EyeOff className="h-[18px] w-[18px]" />
                  ) : (
                    <Eye className="h-[18px] w-[18px]" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || success}
              className="w-full flex justify-center items-center py-3 px-4 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 shadow-lg shadow-emerald-500/25 hover:shadow-emerald-600/30 focus:outline-none focus:ring-[3px] focus:ring-emerald-500/30 focus:ring-offset-1 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none mt-2"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />
                  Đang xác thực...
                </>
              ) : (
                "Đăng nhập"
              )}
            </button>

            <p className="text-xs text-slate-400 text-center pt-1">
              Tài khoản do bộ phận IT cấp. Liên hệ quản lý kho nếu chưa có.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
