"use client";

import { useEffect, useState } from "react";
import { ScrollText, Loader2, Activity } from "lucide-react";
import PlatformLayout from "@/components/platform/PlatformLayout";

interface AuditEntry {
  id: number;
  actor_user_id: string;
  actor_email: string | null;
  impersonating_org_id: string | null;
  impersonating_org_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

const ACTION_LABELS: Record<string, string> = {
  "platform.admin.add": "Thêm quản trị",
  "platform.admin.remove": "Xóa quản trị",
  "platform.org.impersonate": "Vào xem tổ chức",
};

export default function PlatformAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/platform/audit?limit=200", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Không tải được.");
      } else {
        setEntries(data.entries);
      }
      setLoading(false);
    })();
  }, []);

  return (
    <PlatformLayout
      pageTitle="Nhật ký kiểm toán"
      pageSubtitle="Ghi nhận mọi thao tác của quản trị nền tảng — dùng làm bằng chứng khi có sự cố"
      pageIcon={ScrollText}
    >
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 text-xs text-slate-500">
            {entries.length} sự kiện gần nhất
          </div>



          {error && (
            <div className="px-4 py-3 bg-red-50 text-red-600 text-sm">{error}</div>
          )}

          {loading ? (
            <div className="p-8 flex items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-500 mr-2" />
              Đang tải...
            </div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Chưa có sự kiện nào.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {entries.map((e) => (
                <div key={e.id} className="p-4 flex items-start gap-4">
                  <div className="h-9 w-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100">
                    <Activity className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-800">
                        {ACTION_LABELS[e.action] ?? e.action}
                      </span>
                      {e.impersonating_org_name && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono border border-emerald-100">
                          @ {e.impersonating_org_name}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      <span className="font-medium">{e.actor_email ?? "?"}</span>
                      {e.target_id && (
                        <>
                          {" · "}
                          <span className="font-mono">đích: {e.target_id.slice(0, 8)}...</span>
                        </>
                      )}
                      {e.ip_address && <> · IP {e.ip_address}</>}
                    </p>
                    {e.metadata && Object.keys(e.metadata).length > 0 && (
                      <details className="mt-2">
                        <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600">
                          Chi tiết
                        </summary>
                        <pre className="text-[10px] text-slate-500 bg-slate-50 p-2 rounded mt-1 overflow-x-auto">
                          {JSON.stringify(e.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 shrink-0">
                    {new Date(e.created_at).toLocaleString("vi-VN")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PlatformLayout>
  );
}
