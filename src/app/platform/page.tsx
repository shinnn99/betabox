"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  Users,
  Warehouse,
  ArrowRight,
  Loader2,
  Search,
} from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";

async function impersonateOrg(orgId: string) {
  const res = await fetch("/api/platform/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ?? data.error ?? "Vào tổ chức thất bại");
  }
  // Cookie đã set → redirect về dashboard (proxy sẽ ký token từ cookie).
  window.location.href = "/dashboard";
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  stats: { users: number; warehouses: number };
}

export default function PlatformOrgsPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/platform/orgs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Không tải được danh sách.");
      } else {
        setOrgs(data.orgs);
      }
      setLoading(false);
    })();
  }, []);

  const filtered = orgs.filter(
    (o) =>
      o.name.toLowerCase().includes(q.toLowerCase()) ||
      o.slug.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <PlatformLayout
      pageTitle="Tổ chức"
      pageSubtitle="Danh sách mọi tổ chức trên hệ thống — bấm để vào xem"
      pageIcon={Building2}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 h-9 px-3 rounded-xl border border-slate-200 bg-slate-50/60 text-slate-500 flex-1 max-w-sm">
              <Search className="h-4 w-4" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Tìm tên hoặc slug tổ chức..."
                className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
              />
            </div>
            <div className="text-xs text-slate-500 ml-auto">
              Tổng: <b>{orgs.length}</b>
            </div>
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
              {error}
            </div>
          )}

          {loading ? (
            <div className="p-8 flex items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
              Đang tải...
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {q ? "Không tìm thấy tổ chức khớp." : "Chưa có tổ chức nào."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filtered.map((org) => (
                <div
                  key={org.id}
                  className="p-4 flex items-center gap-4 hover:bg-slate-50/50"
                >
                  <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800 truncate">
                      {org.name}
                    </p>
                    <p className="text-xs text-slate-500 font-mono">{org.slug}</p>
                  </div>
                  <div className="hidden md:flex items-center gap-4 text-xs text-slate-500">
                    <div className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      <span>{org.stats.users}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Warehouse className="h-3.5 w-3.5" />
                      <span>{org.stats.warehouses}</span>
                    </div>
                    <div className="text-slate-400">
                      {new Date(org.created_at).toLocaleDateString("vi-VN")}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      impersonateOrg(org.id).catch((e) => setError(e.message));
                    }}
                    className="h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    Vào xem <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PlatformLayout>
  );
}
