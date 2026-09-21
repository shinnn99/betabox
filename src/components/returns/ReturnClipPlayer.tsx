"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";

/**
 * Khung phát một clip bằng chứng trong trang Hàng hoàn.
 *
 * Dùng lại đúng API xem video của đơn đi (`/api/order-proof/{id}/watch`), nên
 * mọi luật đã có vẫn giữ: clip trên cloud sống 72 giờ, hết thì cắt lại từ
 * segment trên máy kho, quá hạn lưu thì báo rõ thay vì quay vòng mãi.
 *
 * Trạng thái nào cũng phải hiện ra chữ. Người dùng đang cần bằng chứng để
 * khiếu nại, im lặng là thứ tệ nhất.
 */

interface WatchResponse {
  state: string;
  signed_url?: string;
  download_url?: string;
  file_name?: string;
  error?: string;
  message?: string;
}

/** Trạng thái còn đang chạy — hỏi lại sau vài giây. */
const WORKING_STATES = ["cutting", "encoding", "uploading", "queued", "offline"];

const STATE_TEXT: Record<string, string> = {
  cutting: "Máy kho đang cắt video…",
  encoding: "Đang ghép video…",
  uploading: "Đang tải video lên…",
  queued: "Đã xếp hàng chờ máy kho…",
  offline: "Máy kho đang offline — sẽ cắt khi máy online lại.",
  offline_giveup: "Máy kho offline quá lâu, chưa cắt được video.",
  open_order: "Kiện chưa đóng nên chưa cắt được video.",
  expired_retention: "Quá hạn lưu trữ — không còn bản gốc để cắt lại.",
  failed: "Cắt video lỗi.",
};

export default function ReturnClipPlayer({
  packingEventId,
  title,
}: {
  packingEventId: string;
  title: string;
}) {
  const [data, setData] = useState<WatchResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Vòng hỏi nằm gọn trong effect: khi khung bị gỡ thì `stopped` cắt vòng,
    // không có timer nào sống sót và không setState trên component đã unmount.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ask = async () => {
      try {
        const res = await fetch(`/api/order-proof/${packingEventId}/watch`, { method: "POST" });
        const body = (await res.json()) as WatchResponse;
        if (stopped) return;
        setData(body);
        // Đang xử lý thì hỏi lại; trạng thái cuối thì dừng, không quay vòng.
        if (WORKING_STATES.includes(body.state)) {
          timer = setTimeout(() => void ask(), 4000);
        }
      } catch {
        if (!stopped) setData({ state: "failed", message: "Không gọi được máy chủ." });
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    void ask();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [packingEventId]);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-xs font-semibold text-slate-700">{title}</p>

      {loading && !data && (
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang hỏi máy chủ…
        </p>
      )}

      {data?.state === "ready" && data.signed_url && (
        <div className="space-y-2">
          <video src={data.signed_url} controls className="w-full rounded-md bg-black" />
          {data.download_url && (
            <a
              href={data.download_url}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800"
            >
              <Download className="h-3.5 w-3.5" />
              Tải về {data.file_name ?? "video"}
            </a>
          )}
        </div>
      )}

      {data && data.state !== "ready" && (
        <p className="flex items-start gap-1.5 text-xs text-slate-600">
          {["failed", "expired_retention", "offline_giveup"].includes(data.state) ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          ) : (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
          )}
          <span>
            {STATE_TEXT[data.state] ?? data.message ?? `Trạng thái: ${data.state}`}
          </span>
        </p>
      )}
    </div>
  );
}
