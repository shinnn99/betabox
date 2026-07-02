"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * 1.2: banner persistent "camera không phải H.264".
 *
 * Đọc /api/cameras/codec-warnings — UNION 2 nguồn (cameras onboard +
 * recording session). Hiện nếu có camera nào codec ≠ 'h264' AND ≠ null.
 * Tắt tự động khi tất cả camera có giá trị đều 'h264' (fact-based, không
 * dismiss được — điều kiện tắt gắn với "sự thật đã sửa", không "người
 * đã xem").
 *
 * Poll mỗi 30s để tự cập nhật khi codec đổi (probe mới, session mới).
 */
interface WarningItem {
  camera_id: string;
  camera_code: string;
  source: "onboard" | "recording";
  codec: string;
  warning: string | null;
}

const POLL_INTERVAL_MS = 30_000;

export default function CodecWarningBanner() {
  const [items, setItems] = useState<WarningItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/cameras/codec-warnings", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: WarningItem[] };
        if (!cancelled) setItems(data.items ?? []);
      } catch {
        // network hiccup, giữ state cũ
      }
    }
    void load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (items.length === 0) return null;

  // Gộp theo camera để không dup nếu cả onboard+recording đều báo cùng cam
  const byCam = new Map<string, WarningItem>();
  for (const it of items) {
    if (!byCam.has(it.camera_id)) byCam.set(it.camera_id, it);
  }
  const uniqueCams = Array.from(byCam.values());

  return (
    <div className="mx-3 lg:mx-0 mt-3 lg:mt-0 mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-red-600" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-red-800">
            Camera chưa dùng H.264 — clip sẽ không xem được trên trình duyệt
          </div>
          <div className="mt-1 text-xs text-red-700">
            {uniqueCams.map((it) => (
              <div key={it.camera_id}>
                • <span className="font-mono font-semibold">{it.camera_code}</span>
                {" "}đang phát <span className="font-mono uppercase">{it.codec}</span>
                {" "}(nguồn: {it.source === "onboard" ? "onboard-probe" : "đang recording"})
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-red-700">
            Vui lòng chỉnh camera sang <span className="font-mono">H.264</span>{" "}
            trong app của nhà sản xuất. Cảnh báo sẽ tự tắt khi codec đổi thành H.264.
          </div>
        </div>
      </div>
    </div>
  );
}
