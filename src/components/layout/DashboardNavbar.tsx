"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Menu,
  LogOut,
  User as UserIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useSession } from "@/lib/useSession";
import { getInitials } from "@/lib/auth";
import { useImpersonatingOrgId } from "@/lib/api-fetch";

interface Props {
  pageTitle?: string;
  pageSubtitle?: string;
  pageIcon?: LucideIcon;
  onMobileMenuToggle?: () => void;
  extras?: ReactNode;
}

export default function DashboardNavbar({
  pageTitle,
  pageSubtitle,
  pageIcon: PageIcon,
  onMobileMenuToggle,
  extras,
}: Props) {
  const { session, signOut } = useSession();
  const impersonatingOrgId = useImpersonatingOrgId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const accountHref = impersonatingOrgId
    ? `/platform/org/${impersonatingOrgId}/dashboard/account`
    : "/dashboard/account";

  const displayName = session?.fullName ?? "...";
  const email = session?.email ?? "";
  const roleLabel = session?.roleLabel ?? "...";
  const initials = session ? getInitials(session.fullName) : "?";

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

  return (
    <header className="flex items-center justify-between h-[56px] lg:h-[72px] px-3 lg:px-6 lg:rounded-2xl lg:border lg:border-slate-100 lg:shadow-sm bg-white shrink-0 border-b border-slate-100 lg:border-b-0">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <button
          onClick={onMobileMenuToggle}
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
              B·Cam
            </p>
            <h1 className="text-sm lg:text-lg font-semibold text-slate-800 leading-tight mt-0.5 truncate">
              {pageTitle ?? "Tổng quan"}
            </h1>
            {pageSubtitle && (
              <p className="hidden lg:block text-xs text-slate-500 truncate">
                {pageSubtitle}
              </p>
            )}
          </div>
        </div>
      </div>

      {extras}

      <div className="flex items-center gap-2 lg:gap-3 shrink-0">
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2.5 focus:outline-none"
          >
            <div className="h-9 w-9 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-xs font-bold border border-emerald-100">
              {initials || "?"}
            </div>
            <div className="text-left hidden lg:block">
              <p className="text-sm font-semibold text-slate-800 leading-tight">
                {displayName}
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
                <p className="text-sm font-medium text-slate-800">
                  {displayName}
                </p>
                <p className="text-xs text-slate-500 truncate">{email}</p>
              </div>
              <div className="h-px bg-slate-100 mx-1" />
              <Link
                href={accountHref}
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <UserIcon className="h-4 w-4" /> Tài khoản
              </Link>
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
  );
}
