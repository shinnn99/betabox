"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Loader2, ShieldOff } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import DashboardSidebar from "./DashboardSidebar";
import DashboardNavbar from "./DashboardNavbar";
import CodecWarningBanner from "@/components/camera/CodecWarningBanner";
import { useSession } from "@/lib/useSession";
import { PermissionsContext, usePermissions } from "@/lib/usePermissions";
import {
  canSeeHref,
  firstAllowedHref,
  navHrefForPath,
} from "@/lib/nav-access";
import {
  PageHeaderSetterContext,
  type PageHeaderState,
} from "./PageHeaderContext";

const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";
const SIDEBAR_CHANGE_EVENT = "betacam:sidebar-collapsed";

function subscribeSidebarCollapsed(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(SIDEBAR_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(SIDEBAR_CHANGE_EVENT, onStoreChange);
  };
}

function getSidebarCollapsedSnapshot() {
  return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
}

function getSidebarCollapsedServerSnapshot() {
  return false;
}

function DashboardContentFrame({
  children,
  can,
  pageAllowed,
  onMobileMenuToggle,
}: {
  children: ReactNode;
  can: (anyOf: string | string[]) => boolean;
  pageAllowed: boolean;
  onMobileMenuToggle: () => void;
}) {
  const [header, setHeader] = useState<PageHeaderState>({
    pageTitle: "Tổng quan",
  });

  return (
    <PageHeaderSetterContext.Provider value={setHeader}>
      <div className="flex-1 flex flex-col gap-0 lg:gap-3 overflow-hidden min-w-0">
        <DashboardNavbar
          pageTitle={header.pageTitle}
          pageSubtitle={header.pageSubtitle}
          pageIcon={header.pageIcon}
          onMobileMenuToggle={onMobileMenuToggle}
          extras={header.headerExtras}
        />
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 lg:px-0 lg:py-0 [scrollbar-gutter:stable] pb-6">
          {pageAllowed ? (
            <PermissionsContext.Provider value={can}>
              <CodecWarningBanner />
              {children}
            </PermissionsContext.Provider>
          ) : (
            <div className="h-full min-h-[320px] flex flex-col items-center justify-center gap-3 text-center px-6">
              <ShieldOff className="h-10 w-10 text-slate-300" />
              <p className="text-base font-semibold text-slate-700">
                Bạn không có quyền xem trang này
              </p>
              <p className="text-sm text-slate-500">
                Liên hệ quản trị viên nếu bạn cần được cấp quyền.
              </p>
            </div>
          )}
        </main>
      </div>
    </PageHeaderSetterContext.Provider>
  );
}

/** Persistent dashboard shell: remains mounted while /dashboard/* pages change. */
export default function DashboardShell({
  children,
  isImpersonating,
}: {
  children: ReactNode;
  isImpersonating: boolean;
}) {
  const { session, loading } = useSession(true);
  const { can, ready: permsReady } = usePermissions(session?.userId);
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const pageHref = navHrefForPath(pathname);
  const pageAllowed = !pageHref || canSeeHref(pageHref, can);
  const redirectTo =
    permsReady && !pageAllowed && pathname === "/dashboard"
      ? firstAllowedHref(can)
      : null;

  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getSidebarCollapsedServerSnapshot,
  );

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const openMobile = useCallback(() => setMobileOpen(true), []);
  const toggleCollapse = useCallback(() => {
    const next = localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "1";
    localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
    window.dispatchEvent(new Event(SIDEBAR_CHANGE_EVENT));
  }, []);

  if (loading || !session || !permsReady || redirectTo) {
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
    <div
      className={`lg:bg-slate-100 overflow-hidden ${
        isImpersonating ? "h-[calc(100vh-40px)] mt-10" : "h-screen"
      }`}
    >
      <div className="h-full flex gap-3 lg:p-3">
        <DashboardSidebar
          mobileOpen={mobileOpen}
          onMobileClose={closeMobile}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          can={can}
        />

        <DashboardContentFrame
          can={can}
          pageAllowed={pageAllowed}
          onMobileMenuToggle={openMobile}
        >
          {children}
        </DashboardContentFrame>
      </div>
    </div>
  );
}
