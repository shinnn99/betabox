"use client";

import { Loader2, Radio, Square } from "lucide-react";
import {
  useReturnCapture,
  type StationOption,
} from "@/components/returns/ReturnCaptureProvider";
import { useCan } from "@/lib/usePermissions";
import { deniedClass } from "@/lib/useGuard";
import { useToast } from "@/components/ui/Toast";

/**
 * Bật / tắt nhận hoàn cho TỪNG BÀN hoặc CẢ KHO trên trang Giám sát hoàn hàng.
 *
 * Đợt 6 (21/09/2026): mọi bàn nhận hoàn song song. Mỗi bàn một ô, bật tắt
 * độc lập; hai nút đầu khung bật / tắt mọi bàn một lượt.
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

function statusOf(s: StationOption): { text: string; tone: string } {
  const c = s.capture;
  if (c.heldByMe && !c.agentAcked) {
    return { text: "Máy chủ kho chưa nhận tín hiệu", tone: "bg-rose-50 text-rose-700 border-rose-200" };
  }
  if (c.heldByMe) {
    return { text: "Đang ghi cho hàng hoàn", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  }
  if (c.state === "active") {
    return { text: "Đang nhận hoàn (nguồn khác)", tone: "bg-amber-50 text-amber-700 border-amber-200" };
  }
  if (c.state === "draining") {
    return { text: "Đang lưu nốt đoạn cuối", tone: "bg-sky-50 text-sky-700 border-sky-200" };
  }
  return { text: "Chưa nhận hoàn", tone: "bg-slate-100 text-slate-600 border-slate-200" };
}

export default function ReturnCapturePanel() {
  const { stations, heldIds, busyIds, start, stop } = useReturnCapture();
  // Mở phiên nhận hoàn là thao tác kho. Không có quyền (Viewer) thì vẫn thấy
  // trạng thái các bàn, bấm nút chỉ nhận thông báo — không gửi gì lên server.
  const can = useCan();
  const toast = useToast();
  const allowed = can("return.operate");
  const denied = deniedClass(allowed);
  const g = (fn: () => void) => () => {
    if (!allowed) {
      toast.error("Bạn không có quyền bật/tắt nhận hoàn.");
      return;
    }
    fn();
  };

  const notHeld = stations.filter((s) => !s.capture.heldByMe).map((s) => s.id);
  // Bàn đang nhận hoàn — kể cả do nguồn khác bật. Phải tắt được, nếu không
  // một tab đã chết sẽ giữ bàn ở chế độ hoàn vĩnh viễn (sự cố 24/09/2026).
  const running = stations.filter((s) => s.capture.heldByMe || s.capture.state === "active");
  const runningIds = running.map((s) => s.id);
  const anyBusy = busyIds.size > 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 lg:p-5 shadow-sm">
      <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-800">Phiên nhận hoàn</p>
          <p className="text-xs text-slate-500">
            {stations.length} bàn · {heldIds.length} đang nhận hoàn
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={g(() => void start(notHeld))}
            disabled={anyBusy || notHeld.length === 0}
            className={`h-8 px-3 rounded-xl text-xs font-semibold text-white bg-emerald-500 hover:bg-emerald-600 inline-flex items-center gap-1.5 disabled:opacity-60${denied}`}
          >
            {anyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
            Bắt đầu tất cả bàn
          </button>
          <button
            type="button"
            onClick={g(() => void stop(runningIds, true))}
            disabled={anyBusy || runningIds.length === 0}
            className={`h-8 px-3 rounded-xl text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 inline-flex items-center gap-1.5 disabled:opacity-60${denied}`}
          >
            <Square className="h-3.5 w-3.5" />
            Kết thúc tất cả
          </button>
        </div>
      </div>

      {stations.length === 0 ? (
        <p className="text-xs text-slate-500">Chưa có bàn nào được khai báo.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {stations.map((s) => {
            const status = statusOf(s);
            const busy = busyIds.has(s.id);
            const held = s.capture.heldByMe;
            return (
              <div
                key={s.id}
                className={`p-3 rounded-xl border ${
                  held ? "border-emerald-200 bg-emerald-50/40" : "border-slate-100 bg-slate-50/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">{s.name}</p>
                    <p className="text-[11px] text-slate-500 font-mono truncate">
                      {s.code}
                      {s.purpose === "return" ? " · chuyên hoàn" : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border ${status.tone}`}
                  >
                    {status.text}
                  </span>
                </div>
                {held || s.capture.state === "active" ? (
                  <button
                    type="button"
                    // Không phải mình giữ thì ép dừng luôn: nguồn kia có
                    // thể là một tab đã chết, không ai gỡ tên nó được nữa.
                    onClick={g(() => void stop([s.id], !held))}
                    disabled={busy}
                    className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-60${denied}`}
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                    {held ? "Kết thúc" : "Ép dừng"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={g(() => void start([s.id]))}
                    disabled={busy}
                    className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold text-white bg-emerald-500 hover:bg-emerald-600 inline-flex items-center gap-1 disabled:opacity-60${denied}`}
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Radio className="h-3 w-3" />}
                    Bắt đầu
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
