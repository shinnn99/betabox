"use client";

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Video } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/nav";
import OrgSwitcherCard from "./OrgSwitcherCard";

interface Props {
  mobileOpen: boolean;
  onMobileClose: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export default function DashboardSidebar({
  mobileOpen,
  onMobileClose,
  collapsed,
  onToggleCollapse,
}: Props) {
  const pathname = usePathname();

  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const indicatorRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const rafId = useRef(0);

  // Impersonate context giờ đi qua cookie (không URL prefix). URL luôn
  // /dashboard/* như tenant thường → sidebar Link href thẳng.
  const isActive = useCallback(
    (href: string) => {
      const path = pathname ?? "";
      if (href === "/dashboard") return path === "/dashboard";
      return path === href || path.startsWith(href + "/");
    },
    [pathname]
  );

  const allItems = NAV_SECTIONS.flatMap((s) => s.children);

  useEffect(() => {
    const compute = () => {
      const ind = indicatorRef.current;
      const nav = navRef.current;
      if (!ind || !nav) return;
      const active = allItems.find((i) => isActive(i.href));
      if (!active) {
        ind.style.opacity = "0";
        return;
      }
      const el = itemRefs.current.get(active.id);
      if (!el) return;
      const navRect = nav.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const top = elRect.top - navRect.top + nav.scrollTop;
      const height = elRect.height;
      if (!initialized.current) {
        ind.style.transition = "none";
        ind.style.top = `${top}px`;
        ind.style.height = `${height}px`;
        ind.style.opacity = "1";
        ind.getBoundingClientRect();
        ind.style.transition =
          "top 0.32s cubic-bezier(0.25,0.46,0.45,0.94), height 0.22s ease, opacity 0.18s ease";
        initialized.current = true;
      } else {
        ind.style.top = `${top}px`;
        ind.style.height = `${height}px`;
        ind.style.opacity = "1";
      }
    };

    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(compute);

    const nav = navRef.current;
    if (!nav) return () => cancelAnimationFrame(rafId.current);
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(compute);
    });
    ro.observe(nav);
    return () => {
      cancelAnimationFrame(rafId.current);
      ro.disconnect();
    };
  }, [pathname, allItems, isActive, collapsed]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/40 z-40 lg:hidden transition-opacity duration-300 ${
          mobileOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
        onClick={onMobileClose}
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
          onClick={onToggleCollapse}
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
            href="/dashboard"
            className="flex items-center gap-2.5 min-w-0 flex-1"
          >
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-md shadow-emerald-500/30 shrink-0">
              <Video className="h-5 w-5 text-white" />
            </div>
            {!collapsed && (
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="text-base font-extrabold text-emerald-600 truncate">
                  Beta OC
                </span>
                <span className="text-[11px] text-slate-500 truncate">
                  Giám sát đóng hàng
                </span>
              </div>
            )}
          </Link>
          <button
            onClick={onMobileClose}
            className="lg:hidden h-7 w-7 rounded-full hover:bg-slate-100 flex items-center justify-center shrink-0 ml-1"
          >
            <X className="h-4 w-4 text-slate-400" />
          </button>
        </div>

        <OrgSwitcherCard collapsed={collapsed} />

        <nav
          ref={navRef}
          className="flex-1 px-3 pb-2 overflow-y-auto relative mb-4 sidebar-nav-scroll"
        >
          <div
            ref={indicatorRef}
            className="absolute bg-gradient-to-r from-emerald-500 to-green-600 rounded-full shadow-md shadow-emerald-200 z-0"
            style={{ top: 0, height: 0, opacity: 0, left: 12, right: 12 }}
          />

          {NAV_SECTIONS.map((section, idx) => (
            <div key={section.id}>
              <div className={`px-3 pb-2 ${idx === 0 ? "pt-1" : "pt-4"}`}>
                {!collapsed && (
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {section.label}
                  </span>
                )}
              </div>
              {section.children.map((child) => {
                const active = isActive(child.href);
                const Icon = child.icon;
                return (
                  <Link
                    key={child.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(child.id, el);
                    }}
                    href={child.href}
                    onClick={onMobileClose}
                    title={collapsed ? child.label : undefined}
                    className={`relative z-10 flex items-center gap-3 px-3 py-1.5 my-0 transition-colors duration-200 group ${
                      active
                        ? "text-white rounded-full"
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
                        {child.label}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
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
    </>
  );
}
