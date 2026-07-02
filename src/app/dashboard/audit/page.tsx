"use client";

import { useEffect, useState, useCallback } from "react";
import { ScrollText, Loader2, RefreshCcw } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const ACTION_LABEL: Record<string, string> = {
  "user.create": "Tạo người dùng",
  "user.update": "Sửa người dùng",
  "user.update+password": "Sửa user (đổi mật khẩu)",
  "user.delete": "Xoá người dùng",
  "organization.update": "Cập nhật tổ chức",
  "warehouse.create": "Tạo kho",
  "warehouse.update": "Sửa kho",
  "warehouse.delete": "Xoá kho",
  "staff.create": "Tạo nhân viên",
  "staff.update": "Sửa nhân viên",
  "staff.delete": "Xoá nhân viên",
  "staff.qr.regenerate": "Cấp lại QR",
};

const ACTION_COLOR: Record<string, string> = {
  create: "bg-emerald-50 text-emerald-700 border-emerald-100",
  update: "bg-blue-50 text-blue-700 border-blue-100",
  delete: "bg-red-50 text-red-700 border-red-100",
  qr: "bg-violet-50 text-violet-700 border-violet-100",
};

function actionColorFor(action: string) {
  if (action.includes("delete")) return ACTION_COLOR.delete;
  if (action.includes("create")) return ACTION_COLOR.create;
  if (action.includes("qr")) return ACTION_COLOR.qr;
  return ACTION_COLOR.update;
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetch("/api/audit?limit=200", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? data.error ?? "Không tải được nhật ký.");
      setLoading(false);
      return;
    }
    setLogs(data.logs);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <DashboardLayout
      pageTitle="Nhật ký hệ thống"
      pageSubtitle="Lịch sử mọi thao tác quản trị quan trọng trong tổ chức"
      pageIcon={ScrollText}
    >
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center gap-3">
          <p className="text-sm text-slate-500">
            Hiển thị {logs.length} bản ghi gần nhất
          </p>
          <button
            onClick={load}
            className="ml-auto h-9 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm inline-flex items-center gap-2"
          >
            <RefreshCcw className="h-4 w-4" /> Làm mới
          </button>
        </div>

        {error && (
          <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
            {error}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60">
              <tr className="text-left text-[11px] tracking-wider text-slate-500">
                <th className="px-4 py-3 font-semibold">Thời gian</th>
                <th className="px-4 py-3 font-semibold">Người thực hiện</th>
                <th className="px-4 py-3 font-semibold">Hành động</th>
                <th className="px-4 py-3 font-semibold">Đối tượng</th>
                <th className="px-4 py-3 font-semibold">Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
                  </td>
                </tr>
              )}
              {!loading && logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                    Chưa có bản ghi nào.
                  </td>
                </tr>
              )}
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50/60 align-top">
                  <td className="px-4 py-3 text-xs text-slate-600 font-mono whitespace-nowrap">
                    {new Date(l.created_at).toLocaleString("vi-VN")}
                  </td>
                  <td className="px-4 py-3 text-slate-700 text-xs">
                    {l.actor_email ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${actionColorFor(
                        l.action
                      )}`}
                    >
                      {ACTION_LABEL[l.action] ?? l.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {l.target_type ? (
                      <>
                        <span className="text-slate-400">{l.target_type}:</span>{" "}
                        <span className="font-mono">{l.target_id?.slice(0, 8)}…</span>
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 font-mono max-w-md truncate">
                    {Object.keys(l.metadata).length > 0
                      ? JSON.stringify(l.metadata)
                      : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
}
