"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import DashboardSidebar from "./DashboardSidebar";
import DashboardNavbar from "./DashboardNavbar";
import CodecWarningBanner from "@/components/camera/CodecWarningBanner";
import { useSession } from "@/lib/useSession";

interface Props {
  children: ReactNode;
  pageTitle?: string;
  pageSubtitle?: string;
  pageIcon?: LucideIcon;
  headerExtras?: ReactNode;
}

export default function DashboardLayout({
  children,
  pageTitle,
  pageSubtitle,
  pageIcon,
  headerExtras,
}: Props) {
  const { session, loading } = useSession(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "1") setCollapsed(true);
  }, []);

  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  if (loading || !session) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-100">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
          <span className="text-sm font-medium">Đang tải phiên đăng nhập...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen lg:bg-slate-100 overflow-hidden">
      <div className="h-full flex gap-3 lg:p-3">
        <DashboardSidebar
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />

        <div className="flex-1 flex flex-col gap-0 lg:gap-3 overflow-hidden min-w-0">
          <DashboardNavbar
            pageTitle={pageTitle}
            pageSubtitle={pageSubtitle}
            pageIcon={pageIcon}
            onMobileMenuToggle={() => setMobileOpen(true)}
            extras={headerExtras}
          />
          <main className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 lg:px-0 lg:py-0 [scrollbar-gutter:stable] pb-6">
            <CodecWarningBanner />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
