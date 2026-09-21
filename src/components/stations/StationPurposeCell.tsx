"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

/**
 * Ô "Chế độ bàn" trong bảng bàn đóng gói.
 *
 * Đây là chế độ MẶC ĐỊNH của bàn, không phải chế độ đang chạy:
 *   - Bàn đóng hàng: quét thẻ HOÀN thì chuyển tạm sang nhận hoàn, và **tự
 *     về** sau 5 phút không thao tác hoặc khi đóng ca.
 *   - Bàn chuyên hoàn: luôn ở chế độ nhận hoàn, không tự về.
 *
 * Đổi ở đây có tác dụng NGAY với bàn đang làm việc (trigger ở database đổi
 * kỳ chế độ đang mở), nên phải hỏi lại trước khi biến một bàn đang đóng
 * hàng thành bàn chuyên hoàn: mã quét sau đó không được đếm vào số đơn.
 */
export default function StationPurposeCell({
  station,
  onSaved,
}: {
  station: { id: string; code: string; purpose?: "outbound" | "return" | null };
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const current = station.purpose === "return" ? "return" : "outbound";

  const save = async (purpose: "outbound" | "return") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/packing-stations/${station.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? "Không đổi được chế độ bàn.");
      }
      toast.success(
        purpose === "return"
          ? `${station.code} là bàn chuyên nhận hàng hoàn. Mã quét ở bàn này không tính vào số đơn.`
          : `${station.code} quay lại là bàn đóng hàng.`,
      );
      setConfirming(false);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onPick = (value: string) => {
    if (value === current) return;
    if (value === "return") {
      setConfirming(true);
      return;
    }
    void save("outbound");
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <select
          value={current}
          disabled={busy}
          onChange={(e) => onPick(e.target.value)}
          aria-label={`Chế độ bàn ${station.code}`}
          className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 outline-none focus:border-emerald-400 disabled:bg-slate-50"
        >
          <option value="outbound">Đóng hàng</option>
          <option value="return">Chuyên nhận hoàn</option>
        </select>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
      </div>

      {confirming && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-1.5 space-y-1">
          <p className="text-[11px] text-amber-900">
            <b>{station.code}</b> sẽ luôn ở chế độ nhận hàng hoàn và không tự về
            đóng hàng. Mã quét ở bàn này <b>không tính vào số đơn</b> của nhân
            viên. Xác nhận?
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save("return")}
              className="h-6 rounded-md bg-amber-500 px-2 text-[11px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              Xác nhận
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="h-6 rounded-md px-2 text-[11px] font-medium text-slate-600 hover:text-slate-800"
            >
              Huỷ
            </button>
          </div>
        </div>
      )}

      {!confirming && current === "return" && (
        <p className="text-[11px] text-amber-700">Không tự về đóng hàng</p>
      )}
    </div>
  );
}
