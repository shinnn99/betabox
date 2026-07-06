"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Loader2,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePlatformSession } from "@/lib/usePlatformSession";
import { PLATFORM_NAV } from "@/lib/platform-nav";

interface Props {
  children: ReactNode;
  pageTitle?: string;
  pageSubtitle?: string;
  pageIcon?: LucideIcon;
}

export default function PlatformLayout({
  children,
  pageTitle,
  pageSubtitle,
  pageIcon: PageIcon,
}: Props) {
  const { session, loading, signOut } = usePlatformSession(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isActive = useCallback(
    (href: string) => {
      const path = pathname ?? "";
      if (href === "/platform") return path === "/platform";
      return path === href || path.startsWith(href + "/");
    },
    [pathname]
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  if (loading || !session) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-100">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
          <span className="text-sm font-medium">Đang tải phiên nền tảng...</span>
        </div>
      </div>
    );
  }

  const initials = session.email.slice(0, 2).toUpperCase();
  const roleLabel =
    session.platformRole === "platform_owner"
      ? "Chủ nền tảng"
      : "Hỗ trợ nền tảng";

  return (
    <div className="h-screen lg:bg-slate-100 overflow-hidden">
      <div className="h-full flex gap-3 lg:p-3">
        <div
          className={`fixed inset-0 bg-black/40 z-40 lg:hidden transition-opacity duration-300 ${
            mobileOpen
              ? "opacity-100 pointer-events-auto"
              : "opacity-0 pointer-events-none"
          }`}
          onClick={() => setMobileOpen(false)}
        />

        <aside
          className={`
            bg-white rounded-2xl border border-slate-100 shadow-sm shrink-0
            flex flex-col overflow-visible
            fixed top-3 left-3 bottom-3 z-50
            lg:static lg:top-auto lg:left-auto lg:bottom-auto lg:z-auto lg:translate-x-0
            ${mobileOpen ? "translate-x-0" : "-translate-x-[110%] lg:translate-x-0"}
            ${collapsed ? "w-[76px]" : "w-[230px]"}
            transition-[width,transform] duration-300
          `}
        >
          <button
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"}
            className="hidden lg:flex absolute -right-3 top-6 h-6 w-6 rounded-full bg-white border border-slate-200 shadow-sm items-center justify-center hover:bg-slate-50 z-20"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5 text-slate-500" />
            )}
          </button>

          <div className="flex items-center px-4 pt-4 pb-2 shrink-0">
            <Link
              href="/platform"
              className="flex items-center gap-2.5 min-w-0 flex-1"
            >
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-md shadow-emerald-500/30 shrink-0">
                <ShieldCheck className="h-5 w-5 text-white" />
              </div>
              {!collapsed && (
                <div className="flex flex-col min-w-0 leading-tight">
                  <span className="text-base font-extrabold text-emerald-600 truncate">
                    Beta OC
                  </span>
                  <span className="text-[11px] text-slate-500 truncate">
                    Quản trị nền tảng
                  </span>
                </div>
              )}
            </Link>
            <button
              onClick={() => setMobileOpen(false)}
              className="lg:hidden h-7 w-7 rounded-full hover:bg-slate-100 flex items-center justify-center shrink-0 ml-1"
            >
              <X className="h-4 w-4 text-slate-400" />
            </button>
          </div>

          <nav className="flex-1 px-3 pb-2 overflow-y-auto mb-4 sidebar-nav-scroll">
            <div className={`px-3 pb-2 pt-1`}>
              {!collapsed && (
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Quản trị
                </span>
              )}
            </div>
            {PLATFORM_NAV.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-3 px-3 py-1.5 my-0 transition-colors duration-200 group ${
                    active
                      ? "text-white rounded-full bg-gradient-to-r from-emerald-500 to-green-600 shadow-md shadow-emerald-200"
                      : "text-slate-700 hover:bg-slate-50 rounded-lg"
                  }`}
                >
                  <div className="h-8 w-8 flex items-center justify-center shrink-0">
                    <Icon
                      className={`h-[18px] w-[18px] transition-colors duration-200 ${
                        active
                          ? "text-white"
                          : "text-slate-400 group-hover:text-slate-700"
                      }`}
                    />
                  </div>
                  {!collapsed && (
                    <span
                      className={`text-[12px] flex-1 whitespace-nowrap overflow-hidden ${
                        active ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {item.label}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {!collapsed && (
            <div className="px-4 py-3 border-t border-slate-100 shrink-0">
              <p className="text-[10px] text-slate-300 leading-relaxed">
                © {new Date().getFullYear()} Betacom JSC.
                <br />
                Phiên bản 1.0
              </p>
            </div>
          )}
        </aside>

        <div className="flex-1 flex flex-col gap-0 lg:gap-3 overflow-hidden min-w-0">
          <header className="flex items-center justify-between h-[56px] lg:h-[72px] px-3 lg:px-6 lg:rounded-2xl lg:border lg:border-slate-100 lg:shadow-sm bg-white shrink-0 border-b border-slate-100 lg:border-b-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                onClick={() => setMobileOpen(true)}
                className="lg:hidden h-9 w-9 flex items-center justify-center rounded-lg hover:bg-slate-100"
              >
                <Menu className="h-5 w-5 text-slate-600" />
              </button>

              <div className="flex items-center gap-3 min-w-0">
                {PageIcon && (
                  <div className="hidden lg:flex p-2 bg-emerald-50 rounded-lg">
                    <PageIcon className="h-5 w-5 text-emerald-600" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="lg:hidden text-xl font-extrabold text-emerald-600 leading-none tracking-tight">
                    Beta OC
                  </p>
                  <h1 className="text-sm lg:text-lg font-semibold text-slate-800 leading-tight mt-0.5 truncate">
                    {pageTitle ?? "Quản trị nền tảng"}
                  </h1>
                  {pageSubtitle && (
                    <p className="hidden lg:block text-xs text-slate-500 truncate">
                      {pageSubtitle}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 lg:gap-3 shrink-0">
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex items-center gap-2.5 focus:outline-none"
                >
                  <div className="h-9 w-9 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-xs font-bold border border-emerald-100">
                    {initials}
                  </div>
                  <div className="text-left hidden lg:block">
                    <p className="text-sm font-semibold text-slate-800 leading-tight">
                      {session.email}
                    </p>
                    <p className="text-[11px] text-slate-400 leading-tight">
                      {roleLabel}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400 hidden lg:block" />
                </button>

                {menuOpen && (
                  <div className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-100 bg-white shadow-lg shadow-slate-200/50 py-1.5 z-50">
                    <div className="px-3 py-2">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {session.email}
                      </p>
                      <p className="text-xs text-slate-500">{roleLabel}</p>
                    </div>
                    <div className="h-px bg-slate-100 mx-1" />
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        signOut();
                      }}
                      className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      <LogOut className="h-4 w-4" /> Đăng xuất
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 lg:px-0 lg:py-0 [scrollbar-gutter:stable] pb-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
