"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, Check, Loader2 } from "lucide-react";
import { useSession } from "@/lib/useSession";

interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  status: string;
}

interface Props {
  collapsed: boolean;
}

export default function OrgSwitcherCard({ collapsed }: Props) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const wrapperRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/organization", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được tổ chức.");
      setLoading(false);
      return;
    }
    setOrg(data.organization);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (collapsed) setOpen(false);
  }, [collapsed]);

  const displayName = org?.name ?? session?.organizationName ?? "Tổ chức";
  const displaySlug = org?.slug ?? "";

  if (collapsed) {
    return (
      <div className="px-3 pt-3 pb-2">
        <div
          title={displayName}
          className="h-10 w-10 mx-auto rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center overflow-hidden"
        >
          {org?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={org.logo_url} alt={displayName} className="h-full w-full object-cover" />
          ) : (
            <Building2 className="h-5 w-5" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative px-3 pt-3 pb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2.5 p-2 rounded-xl border transition-colors ${
          open
            ? "border-emerald-200 bg-emerald-50/60"
            : "border-slate-100 hover:bg-slate-50"
        }`}
      >
        <div className="h-9 w-9 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center overflow-hidden shrink-0">
          {org?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={org.logo_url} alt={displayName} className="h-full w-full object-cover" />
          ) : (
            <Building2 className="h-4 w-4" />
          )}
        </div>
        <div className="flex-1 min-w-0 text-left leading-tight">
          <p className="text-[12px] font-bold text-slate-800 truncate">{displayName}</p>
          <p className="text-[10px] text-slate-500 font-mono truncate">
            {displaySlug || "—"}
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-slate-400 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-[calc(100%-2px)] mt-1 z-30 bg-white rounded-2xl border border-slate-200 shadow-xl shadow-slate-200/60 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Tổ chức của bạn
            </p>
          </div>

          {loading ? (
            <div className="px-3 py-4 text-center text-slate-400 text-xs">
              <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> Đang tải...
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-red-600 text-xs">{error}</div>
          ) : org ? (
            <div className="p-1.5">
              <div className="flex items-center gap-2.5 p-2 rounded-lg bg-emerald-50/60 border border-emerald-100">
                <div className="h-8 w-8 rounded-lg bg-white text-emerald-600 border border-emerald-100 flex items-center justify-center overflow-hidden shrink-0">
                  {org.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={org.logo_url} alt={org.name} className="h-full w-full object-cover" />
                  ) : (
                    <Building2 className="h-4 w-4" />
                  )}
                </div>
                <div className="flex-1 min-w-0 leading-tight">
                  <p className="text-[12px] font-bold text-slate-800 truncate">{org.name}</p>
                  <p className="text-[10px] text-slate-500 font-mono truncate">{org.slug}</p>
                </div>
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
