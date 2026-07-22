"use client";

import { useEffect, useState, useCallback } from "react";
import { HardDrive, Loader2, Save, AlertTriangle } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useToast } from "@/components/ui/Toast";

const RETENTION_MIN = 7;
const RETENTION_MAX = 365;

export default function RetentionSettingsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [input, setInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/organization", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Không tải được cấu hình.");
        return;
      }
      const rd = json.organization?.retention_days ?? null;
      setCurrent(rd);
      setInput(rd === null ? "" : String(rd));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    const trimmed = input.trim();
    let value: number | null;
    if (trimmed === "") {
      value = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < RETENTION_MIN || n > RETENTION_MAX) {
        toast.error(
          `Số ngày giữ phải trong khoảng ${RETENTION_MIN}-${RETENTION_MAX} (hoặc để trống).`,
        );
        return;
      }
      value = n;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/organization", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: value }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.message ?? json.error ?? "Lưu thất bại.");
        return;
      }
      setCurrent(value);
      toast.success(
        value === null
          ? "Đã xóa cấu hình retention."
          : `Đã lưu retention = ${value} ngày. Agent sẽ nhận qua heartbeat kế tiếp (≤30s).`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = (input.trim() === "" ? null : Number(input.trim())) !== current;

  return (
    <DashboardLayout
      pageTitle="Cấu hình thời gian lưu video"
      pageSubtitle="Số ngày giữ video segment gốc trên máy kho trước khi tự xóa"
      pageIcon={HardDrive}
    >
      <div className="max-w-2xl space-y-4">
        <div className="bg-white rounded border border-slate-200 p-5 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải...
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Số ngày giữ video
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={RETENTION_MIN}
                    max={RETENTION_MAX}
                    step={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Để trống = chưa cấu hình"
                    className="w-32 rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-500">ngày</span>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Lưu
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Chấp nhận {RETENTION_MIN}-{RETENTION_MAX} ngày. Để trống nếu
                  chưa muốn cấu hình.
                </p>
              </div>

              {current === null && (
                <div className="flex gap-2 p-3 rounded bg-amber-50 border border-amber-200 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">Chưa cấu hình retention</div>
                    <div className="text-xs mt-1">
                      Script cleanup trên máy kho sẽ KHÔNG chạy (không xóa gì)
                      cho tới khi cấu hình. Ổ sẽ đầy dần.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="bg-slate-50 rounded border border-slate-200 p-4 text-sm text-slate-700 space-y-2">
          <div className="font-medium text-slate-900">Lưu ý khi chọn số</div>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>
              Phải ≥ cửa sổ khiếu nại dài nhất của sàn bán hàng (Shopee, TikTok,
              Lazada...). Sàn cho khiếu nại 30 ngày mà chọn 25 = tranh chấp
              ngày 26 sẽ mất bằng chứng.
            </li>
            <li>
              Cộng thêm biên cho chuỗi khiếu nại leo thang (khách → sàn → Betacom
              kháng nghị). Đề: cửa sổ sàn + 10-15 ngày.
            </li>
            <li>
              Đổi số không cần khởi động lại agent. Agent nhận qua heartbeat
              trong ≤30 giây và cache xuống máy kho.
            </li>
            <li>
              Cleanup script chạy hàng tuần (Chủ nhật 03:00). Đổi từ 45 xuống
              30 sẽ khiến file cũ hơn 30 ngày bị xóa ở lần chạy kế tiếp.
            </li>
          </ul>
        </div>
      </div>
    </DashboardLayout>
  );
}
