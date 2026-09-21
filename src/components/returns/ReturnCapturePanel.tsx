"use client";

import { Loader2, Radio, Square } from "lucide-react";
import { useReturnCapture } from "@/components/returns/ReturnCaptureProvider";

/**
 * Nút Bắt đầu / Kết thúc nhận hoàn trên trang Giám sát hoàn hàng.
 *
 * Chỉ là phần hiển thị. Nhịp giữ phiên và tín hiệu đóng khi rời phân hệ nằm
 * ở ReturnCaptureProvider (layout của route group), để chuyển sang trang
 * Bằng chứng hoàn hàng không làm đứt phiên.
 *
 * Camera của bàn vẫn ghi liên tục cho đơn đi — nút này không bật tắt
 * ffmpeg. Nó quyết định đoạn video nào THUỘC VỀ luồng hàng hoàn.
 *
 * Nói thật trạng thái: agent chưa nhận tín hiệu thì KHÔNG hiện "đang ghi",
 * vì lúc đó không đoạn nào được gán nhãn.
 */
export default function ReturnCapturePanel() {
  const { stations, stationId, setStationId, view, busy, start, stop } = useReturnCapture();

  const statusLabel = (() => {
    if (view.heldByMe && !view.agentAcked) {
      return { text: "Máy chủ kho chưa nhận tín hiệu", tone: "bg-rose-50 text-rose-700 border-rose-200" };
    }
    if (view.heldByMe) {
      return { text: "Đang ghi cho hàng hoàn", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    }
    if (view.state === "active") {
      return { text: "Bàn đang nhận hoàn (nguồn khác)", tone: "bg-amber-50 text-amber-700 border-amber-200" };
    }
    if (view.state === "draining") {
      return { text: "Đang lưu nốt đoạn cuối", tone: "bg-sky-50 text-sky-700 border-sky-200" };
    }
    return { text: "Chưa nhận hoàn", tone: "bg-slate-100 text-slate-600 border-slate-200" };
  })();

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-800">Phiên nhận hoàn</p>
          <p className="text-xs text-slate-500">
            Camera của bàn vẫn ghi liên tục cho đơn đi. Bật phiên để đánh dấu đoạn
            video nào thuộc hàng hoàn — đoạn đang ghi dở lúc thoát vẫn được lưu nốt.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
            disabled={busy || view.heldByMe}
            aria-label="Bàn nhận hoàn"
            className="min-w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50"
          >
            <option value="">Chọn bàn nhận hoàn</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
                {s.purpose === "return" ? " (chuyên hoàn)" : ""}
              </option>
            ))}
          </select>

          {view.heldByMe ? (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={busy}
              className="h-8 px-3 rounded-xl text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Kết thúc nhận hoàn
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy || !stationId}
              className="h-8 px-3 rounded-xl text-xs font-semibold text-white bg-emerald-500 hover:bg-emerald-600 inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
              Bắt đầu nhận hoàn
            </button>
          )}

          <span
            className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${statusLabel.tone}`}
          >
            {statusLabel.text}
          </span>
        </div>
      </div>
    </div>
  );
}
