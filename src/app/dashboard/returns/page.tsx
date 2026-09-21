"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, PackageOpen, RefreshCw } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import ReturnClipPlayer from "@/components/returns/ReturnClipPlayer";
import ReturnCapturePanel from "@/components/returns/ReturnCapturePanel";

/**
 * Trang Hàng hoàn.
 *
 * Sắp theo hạn xử lý: hồ sơ còn mở, hạn gần nhất lên đầu. Mỗi dòng mở ra
 * được hai video của cùng một mã — video mở kiện hoàn và video lúc đóng gói
 * gửi đi — vì đặt cạnh nhau mới thấy được hàng có bị tráo hay không.
 */

interface ReturnItem {
  event_id: string;
  waybill_code: string | null;
  scanned_at: string;
  closed_at: string | null;
  duration_seconds: number | null;
  is_open: boolean;
  return_kind: string | null;
  inspection_result: string | null;
  inspection_label: string | null;
  close_reason: string | null;
  station: { code: string; name: string } | null;
  staff: { staff_code: string; full_name: string } | null;
  clip_status: string | null;
  outbound: { event_id: string; scanned_at: string; clip_status: string | null } | null;
  claim: {
    id: string;
    status: string;
    deadline_at: string;
    platform_claim_ref: string | null;
    note: string | null;
  } | null;
}

const CLAIM_LABEL: Record<string, string> = {
  open: "Cần xử lý",
  submitted: "Đã khiếu nại",
  dismissed: "Không cần",
  expired: "Hết hạn",
};

const CLAIM_TONE: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  submitted: "bg-emerald-100 text-emerald-700",
  dismissed: "bg-slate-100 text-slate-600",
  expired: "bg-rose-100 text-rose-700",
};

const KIND_LABEL: Record<string, string> = {
  rts: "Giao thất bại",
  customer_return: "Khách trả",
  suspect: "Quét ở bàn đóng hàng",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("vi-VN", { hour12: false });
}

function remainingLabel(deadlineIso: string): string {
  const ms = Date.parse(deadlineIso) - Date.now();
  if (ms <= 0) return "hết hạn";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `còn ${Math.floor(hours / 24)} ngày`;
  if (hours >= 1) return `còn ${hours} giờ`;
  return `còn ${Math.max(1, Math.floor(ms / 60_000))} phút`;
}

export default function ReturnsPage() {
  const toast = useToast();
  const [items, setItems] = useState<ReturnItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [busyClaim, setBusyClaim] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/returns?claim_status=${filter}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Không tải được danh sách hàng hoàn.");
      const body = (await res.json()) as { returns: ReturnItem[] };
      setItems(body.returns ?? []);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateClaim = async (
    claimId: string,
    patch: { status?: "submitted" | "dismissed"; platform_claim_ref?: string },
  ) => {
    setBusyClaim(claimId);
    try {
      const res = await fetch(`/api/returns/claims/${claimId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? "Không cập nhật được hồ sơ.");
      }
      toast.success(
        patch.status === "submitted" ? "Đã ghi nhận đã khiếu nại." : "Đã đánh dấu không cần xử lý.",
      );
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyClaim(null);
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <PackageOpen className="h-5 w-5 text-amber-600" />
            Hàng hoàn
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Kiện hàng khách trả hoặc giao thất bại quay về. Kiện hoàn không tính
            vào số đơn đóng của nhân viên.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700"
            aria-label="Lọc theo hồ sơ"
          >
            <option value="all">Tất cả</option>
            <option value="open">Cần xử lý</option>
            <option value="submitted">Đã khiếu nại</option>
            <option value="dismissed">Không cần</option>
            <option value="expired">Hết hạn</option>
            <option value="none">Không có hồ sơ</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Tải lại
          </button>
        </div>
      </div>

      <ReturnCapturePanel />

      {loading ? (
        <div className="flex items-center gap-2 p-10 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Chưa có kiện hàng hoàn nào.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.event_id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono font-semibold text-slate-900">
                    {item.waybill_code ?? "(không đọc được mã)"}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {formatTime(item.scanned_at)}
                    {item.station ? ` · ${item.station.code}` : ""}
                    {item.staff ? ` · ${item.staff.staff_code}` : ""}
                    {item.return_kind ? ` · ${KIND_LABEL[item.return_kind] ?? item.return_kind}` : ""}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {item.is_open ? (
                    <span className="rounded-lg bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">
                      Đang kiểm
                    </span>
                  ) : (
                    <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {item.inspection_label ?? "Đã đóng"}
                    </span>
                  )}
                  {item.claim && (
                    <span
                      className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                        CLAIM_TONE[item.claim.status] ?? "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {CLAIM_LABEL[item.claim.status] ?? item.claim.status}
                      {item.claim.status === "open"
                        ? ` · ${remainingLabel(item.claim.deadline_at)}`
                        : ""}
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setOpenEvent((prev) => (prev === item.event_id ? null : item.event_id))
                  }
                  disabled={item.is_open}
                  title={item.is_open ? "Kiện chưa đóng nên chưa cắt được video" : undefined}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {openEvent === item.event_id ? "Ẩn video" : "Xem video"}
                </button>

                {item.claim && item.claim.status === "open" && (
                  <>
                    <button
                      type="button"
                      disabled={busyClaim === item.claim.id}
                      onClick={() => void updateClaim(item.claim!.id, { status: "submitted" })}
                      className="h-8 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Đã khiếu nại
                    </button>
                    <button
                      type="button"
                      disabled={busyClaim === item.claim.id}
                      onClick={() => void updateClaim(item.claim!.id, { status: "dismissed" })}
                      className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Không cần
                    </button>
                  </>
                )}

                {item.close_reason === "timeout" && (
                  <span className="text-[11px] text-amber-700">Tự dừng vì quá giờ</span>
                )}
                {item.close_reason === "suspect" && (
                  <span className="text-[11px] text-amber-700">
                    Quét nhầm ở bàn đóng hàng — chưa ai mở kiểm
                  </span>
                )}
              </div>

              {openEvent === item.event_id && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <ReturnClipPlayer
                    packingEventId={item.event_id}
                    title="Video mở kiện hoàn"
                  />
                  {item.outbound ? (
                    <ReturnClipPlayer
                      packingEventId={item.outbound.event_id}
                      title={`Video đóng gửi đi · ${formatTime(item.outbound.scanned_at)}`}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 p-4 text-xs text-slate-500">
                      Mã này chưa từng đóng gửi đi trong hệ thống (thường là kiện
                      khách trả, sàn cấp mã mới), nên không có video đối chiếu.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
