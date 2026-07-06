"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import {
  Mail,
  Lock,
  User,
  Building2,
  Phone,
  Eye,
  EyeOff,
  Loader2,
  Video,
  ShieldCheck,
  Sparkles,
  Rocket,
} from "lucide-react";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (
        selector: string | HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "error-callback"?: () => void;
        }
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    organization_name: "",
    phone: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    const renderWidget = () => {
      if (window.turnstile && turnstileRef.current && !widgetIdRef.current) {
        widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token: string) => setTurnstileToken(token),
          "error-callback": () => setTurnstileToken(null),
          // @ts-expect-error size supported by Turnstile at runtime
          size: "flexible",
        });
      }
    };
    if (window.turnstile) renderWidget();
    const iv = setInterval(() => {
      if (window.turnstile) {
        renderWidget();
        clearInterval(iv);
      }
    }, 200);
    return () => clearInterval(iv);
  }, []);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    // Clear field error khi user bắt đầu gõ lại
    if (fieldErrors[e.target.name]) {
      setFieldErrors({ ...fieldErrors, [e.target.name]: "" });
    }
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.organization_name.trim()) {
      errs.organization_name = "Vui lòng nhập tên tổ chức.";
    }
    if (!form.full_name.trim()) {
      errs.full_name = "Vui lòng nhập họ tên.";
    }
    if (!form.email.trim()) {
      errs.email = "Vui lòng nhập email.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errs.email = "Email không đúng định dạng.";
    }
    if (!form.password) {
      errs.password = "Vui lòng nhập mật khẩu.";
    } else if (form.password.length < 8) {
      errs.password = "Mật khẩu phải có ít nhất 8 ký tự.";
    }
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      errs._captcha = "Vui lòng xác nhận bạn không phải robot.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validate()) {
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          turnstile_token: turnstileToken,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message || data.error || "Đăng ký lỗi");
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.reset(widgetIdRef.current);
          setTurnstileToken(null);
        }
        setLoading(false);
        return;
      }

      setSuccess(true);
      // Redirect login sau 1 nhịp để user thấy thành công
      setTimeout(() => {
        router.push("/login?signup=success");
      }, 800);
    } catch (err) {
      setError((err as Error).message || "Đăng ký lỗi");
      setLoading(false);
    }
  };

  return (
    <>
      {TURNSTILE_SITE_KEY && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
        />
      )}

      <div className="min-h-screen flex w-full overflow-hidden bg-gradient-to-br from-emerald-50/30 via-white to-green-50/30">
        {/* LEFT — Brand hero */}
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

            <div
              className="max-w-lg -mt-8"
              style={{
                fontFamily:
                  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
                wordBreak: "keep-all",
              }}
            >
              <div className="mb-5 space-y-1.5">
                <h1 className="text-2xl md:text-3xl xl:text-[2.75rem] font-bold leading-[1.15]">
                  Bắt đầu dùng thử
                </h1>
                <h1 className="text-2xl md:text-3xl xl:text-[2.75rem] font-bold leading-[1.15] bg-gradient-to-r from-emerald-300 via-green-300 to-emerald-400 bg-clip-text text-transparent">
                  Miễn phí ngay hôm nay
                </h1>
              </div>
              <p className="text-emerald-200/80 text-sm md:text-base leading-relaxed max-w-md">
                Đăng ký tài khoản trong vài phút. Cài đặt kho, gắn camera, và
                bắt đầu giám sát đóng hàng cùng đo lường hiệu suất nhân viên.
              </p>

              <div className="mt-10 flex flex-col gap-4">
                {[
                  {
                    icon: Rocket,
                    title: "Khởi tạo tổ chức chỉ trong 2 phút",
                    desc: "Đăng ký → cấu hình kho → gắn camera → chạy",
                  },
                  {
                    icon: ShieldCheck,
                    title: "Multi-tenant bảo mật cấp doanh nghiệp",
                    desc: "Dữ liệu tổ chức của bạn được cô lập tuyệt đối",
                  },
                  {
                    icon: Sparkles,
                    title: "Không cần thẻ tín dụng",
                    desc: "Trải nghiệm đầy đủ tính năng, nâng cấp khi cần",
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

        {/* RIGHT — Form */}
        <div className="w-full lg:w-[45%] flex items-center justify-center px-6 py-6 sm:p-10 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-100/40 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-64 h-64 bg-green-100/30 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2 pointer-events-none" />

          <div className="w-full max-w-[460px] relative">
            {/* Mobile logo */}
            <div className="mb-6 lg:hidden flex items-center gap-3">
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

            <div className="mb-6">
              <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-2 tracking-tight">
                Đăng ký tài khoản
              </h2>
              <p className="text-slate-500 text-sm">
                Tạo tổ chức mới và bắt đầu sử dụng ngay.
              </p>
            </div>

            {error && (
              <div className="mb-4 p-3.5 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm flex items-center gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
                  <span className="text-red-700 text-lg font-bold">!</span>
                </div>
                <span>{error}</span>
              </div>
            )}

            {success && (
              <div className="mb-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
                <span>Đăng ký thành công! Đang chuyển đến trang đăng nhập...</span>
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100/80 p-6 sm:p-7 space-y-4"
            >
              {/* Organization name */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 block">
                  Tên tổ chức <span className="text-red-500">*</span>
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Building2
                      className={`h-[18px] w-[18px] transition-colors ${
                        fieldErrors.organization_name
                          ? "text-red-400"
                          : "text-slate-400 group-focus-within:text-emerald-500"
                      }`}
                    />
                  </div>
                  <input
                    type="text"
                    name="organization_name"
                    value={form.organization_name}
                    onChange={handleChange}
                    className={`block w-full pl-11 pr-4 py-2.5 border rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none transition-all ${
                      fieldErrors.organization_name
                        ? "border-red-300 bg-red-50/40 focus:bg-white focus:border-red-400 focus:ring-[3px] focus:ring-red-500/10"
                        : "border-slate-200 bg-slate-50/50 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10"
                    }`}
                    placeholder="Công ty ABC"
                  />
                </div>
                {fieldErrors.organization_name && (
                  <p className="text-xs text-red-600 mt-1">
                    {fieldErrors.organization_name}
                  </p>
                )}
              </div>

              {/* Full name */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 block">
                  Họ tên <span className="text-red-500">*</span>
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <User
                      className={`h-[18px] w-[18px] transition-colors ${
                        fieldErrors.full_name
                          ? "text-red-400"
                          : "text-slate-400 group-focus-within:text-emerald-500"
                      }`}
                    />
                  </div>
                  <input
                    type="text"
                    name="full_name"
                    value={form.full_name}
                    onChange={handleChange}
                    className={`block w-full pl-11 pr-4 py-2.5 border rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none transition-all ${
                      fieldErrors.full_name
                        ? "border-red-300 bg-red-50/40 focus:bg-white focus:border-red-400 focus:ring-[3px] focus:ring-red-500/10"
                        : "border-slate-200 bg-slate-50/50 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10"
                    }`}
                    placeholder="Nguyễn Văn A"
                  />
                </div>
                {fieldErrors.full_name && (
                  <p className="text-xs text-red-600 mt-1">
                    {fieldErrors.full_name}
                  </p>
                )}
              </div>

              {/* Email */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 block">
                  Email <span className="text-red-500">*</span>
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Mail
                      className={`h-[18px] w-[18px] transition-colors ${
                        fieldErrors.email
                          ? "text-red-400"
                          : "text-slate-400 group-focus-within:text-emerald-500"
                      }`}
                    />
                  </div>
                  <input
                    type="text"
                    name="email"
                    value={form.email}
                    onChange={handleChange}
                    className={`block w-full pl-11 pr-4 py-2.5 border rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none transition-all ${
                      fieldErrors.email
                        ? "border-red-300 bg-red-50/40 focus:bg-white focus:border-red-400 focus:ring-[3px] focus:ring-red-500/10"
                        : "border-slate-200 bg-slate-50/50 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10"
                    }`}
                    placeholder="you@company.com"
                  />
                </div>
                {fieldErrors.email && (
                  <p className="text-xs text-red-600 mt-1">{fieldErrors.email}</p>
                )}
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 block">
                  Mật khẩu <span className="text-red-500">*</span>{" "}
                  <span className="text-slate-400 font-normal">(≥8 ký tự)</span>
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Lock
                      className={`h-[18px] w-[18px] transition-colors ${
                        fieldErrors.password
                          ? "text-red-400"
                          : "text-slate-400 group-focus-within:text-emerald-500"
                      }`}
                    />
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    name="password"
                    value={form.password}
                    onChange={handleChange}
                    autoComplete="new-password"
                    className={`block w-full pl-11 pr-11 py-2.5 border rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none transition-all ${
                      fieldErrors.password
                        ? "border-red-300 bg-red-50/40 focus:bg-white focus:border-red-400 focus:ring-[3px] focus:ring-red-500/10"
                        : "border-slate-200 bg-slate-50/50 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10"
                    }`}
                    placeholder="Ít nhất 8 ký tự"
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
                {fieldErrors.password && (
                  <p className="text-xs text-red-600 mt-1">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              {/* Phone (optional) */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 block">
                  Số điện thoại{" "}
                  <span className="text-slate-400 font-normal">(tuỳ chọn)</span>
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Phone className="h-[18px] w-[18px] text-slate-400 group-focus-within:text-emerald-500 transition-colors" />
                  </div>
                  <input
                    type="tel"
                    name="phone"
                    value={form.phone}
                    onChange={handleChange}
                    className="block w-full pl-11 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-800 bg-slate-50/50 placeholder:text-slate-400 focus:bg-white focus:border-emerald-400 focus:ring-[3px] focus:ring-emerald-500/10 focus:outline-none transition-all"
                    placeholder="09xxxxxxxx"
                  />
                </div>
              </div>

              {/* Turnstile */}
              {TURNSTILE_SITE_KEY && (
                <div className="space-y-1.5">
                  <div
                    ref={turnstileRef}
                    className="w-full [&_iframe]:!w-full [&>div]:!w-full"
                  />
                  {fieldErrors._captcha && (
                    <p className="text-xs text-red-600">
                      {fieldErrors._captcha}
                    </p>
                  )}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={
                  loading || success || (Boolean(TURNSTILE_SITE_KEY) && !turnstileToken)
                }
                className="w-full flex justify-center items-center py-3 px-4 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 shadow-lg shadow-emerald-500/25 hover:shadow-emerald-600/30 focus:outline-none focus:ring-[3px] focus:ring-emerald-500/30 focus:ring-offset-1 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none mt-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />
                    Đang tạo tài khoản...
                  </>
                ) : (
                  "Đăng ký"
                )}
              </button>

              <p className="text-sm text-slate-500 text-center pt-2">
                Đã có tài khoản?{" "}
                <a
                  href="/login"
                  className="font-semibold text-emerald-600 hover:text-emerald-700"
                >
                  Đăng nhập
                </a>
              </p>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
