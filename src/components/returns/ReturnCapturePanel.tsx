"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Radio, Square } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

/**
 * Bật/tắt phiên ghi hoàn cho một bàn.
 *
 * Camera của bàn vẫn ghi liên tục cho luồng đóng hàng — nút này không bật
 * tắt ffmpeg. Nó quyết định đoạn video nào **thuộc về** luồng hàng hoàn:
 * chỉ đoạn thuộc phiên mới được rút hạn lưu xuống 7 ngày và dùng làm video
 * kiện hoàn.
 *
 * Ba việc phải đúng, vì sai là mất bằng chứng chứ không phải hiển thị xấu:
 *   1. Nhịp 30 giây. Trình duyệt sập thì cloud tự nhả sau 2 phút.
 *   2. Rời trang thì gửi tín hiệu đóng, kể cả lúc đóng tab (sendBeacon).
 *   3. Nói thật trạng thái: agent chưa nhận tín hiệu thì KHÔNG được hiện
 *      "đang ghi", vì lúc đó không đoạn nào được gán nhãn.
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
 */

const STORAGE_KEY = "betabox.returns.capture-station";
const HEARTBEAT_MS = 30_000;

interface StationOption {
  id: string;
  code: string;
  name: string;
  purpose: string | null;
}

type CaptureState = "none" | "active" | "draining" | "finished" | "abandoned";

interface CaptureView {
  state: CaptureState;
  heldByMe: boolean;
  agentAcked: boolean;
}

const IDLE: CaptureView = { state: "none", heldByMe: false, agentAcked: false };

export default function ReturnCapturePanel() {
  const toast = useToast();
  const [stations, setStations] = useState<StationOption[]>([]);
  const [stationId, setStationId] = useState("");
  const [view, setView] = useState<CaptureView>(IDLE);
  const [busy, setBusy] = useState(false);

  // Tín hiệu đóng lúc rời trang chạy ngoài vòng render nên phải đọc giá
  // trị mới nhất qua ref. Gán trong effect, không gán khi render.
  const stationRef = useRef("");
  const heldRef = useRef(false);
  useEffect(() => {
    stationRef.current = stationId;
    heldRef.current = view.heldByMe;
  }, [stationId, view.heldByMe]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/returns/capture", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { stations?: StationOption[] };
        if (cancelled) return;
        const list = body.stations ?? [];
        setStations(list);
        const saved = window.localStorage.getItem(STORAGE_KEY) ?? "";
        const pick =
          list.find((s) => s.id === saved)?.id ??
          list.find((s) => s.purpose === "return")?.id ??
          "";
        if (pick) setStationId(pick);
      } catch {
        // Không tải được danh sách bàn thì chỉ mất nút bật, không chặn trang.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const readStatus = useCallback(async (id: string) => {
    const res = await fetch(`/api/returns/capture?station_id=${id}`, { cache: "no-store" });
    if (!res.ok) return IDLE;
    const body = (await res.json()) as {
      state?: CaptureState;
      held_by_me?: boolean;
      agent_acked?: boolean;
    };
    return {
      state: body.state ?? "none",
      heldByMe: Boolean(body.held_by_me),
      agentAcked: Boolean(body.agent_acked),
    };
  }, []);

  useEffect(() => {
    if (!stationId) return;
    window.localStorage.setItem(STORAGE_KEY, stationId);
    let cancelled = false;
    void (async () => {
      const status = await readStatus(stationId);
      if (!cancelled) setView(status);
    })();
    return () => {
      cancelled = true;
    };
  }, [stationId, readStatus]);

  // Nhịp giữ phiên. Chỉ chạy khi CHÍNH mình đang giữ.
  useEffect(() => {
    if (!view.heldByMe || !stationId) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch("/api/returns/capture", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ station_id: stationId, action: "heartbeat" }),
          });
          const body = (await res.json()) as {
            ok?: boolean;
            state?: CaptureState;
            agent_acked?: boolean;
          };
          setView({
            state: body.state ?? "none",
            // ok=false nghĩa là phiên đã đóng ở nơi khác (thẻ ĐÓNG HÀNG,
            // đóng ca). Bỏ nhận giữ ngay để người dùng thấy đúng sự thật.
            heldByMe: Boolean(body.ok),
            agentAcked: Boolean(body.agent_acked),
          });
        } catch {
          // Mất mạng: giữ nguyên màn hình. Cloud tự nhả sau 2 phút.
        }
      })();
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [view.heldByMe, stationId]);

  // Rời trang / đóng tab: gửi tín hiệu đóng. sendBeacon vì fetch thường bị
  // huỷ khi trang unload.
  useEffect(() => {
    const closeBeacon = () => {
      if (!heldRef.current || !stationRef.current) return;
      const payload = JSON.stringify({ station_id: stationRef.current, action: "close" });
      navigator.sendBeacon(
        "/api/returns/capture",
        new Blob([payload], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", closeBeacon);
    return () => {
      window.removeEventListener("pagehide", closeBeacon);
      closeBeacon();
    };
  }, []);

  const start = async () => {
    if (!stationId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/returns/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ station_id: stationId, action: "open" }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        message?: string;
        camera_count?: number;
        agent_notified?: boolean;
      };
      if (!res.ok) throw new Error(body.message ?? "Không bật được phiên nhận hoàn.");
      if ((body.camera_count ?? 0) === 0) {
        toast.error("Bàn này chưa gắn camera nào — sẽ không có video kiện hoàn.");
      } else if (!body.agent_notified) {
        toast.error("Chưa gửi được tín hiệu cho máy chủ kho. Video chưa được đánh dấu.");
      } else {
        toast.success("Đã bật nhận hoàn cho bàn này.");
      }
      setView(await readStatus(stationId));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!stationId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/returns/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ station_id: stationId, action: "close" }),
      });
      const body = (await res.json()) as { still_held?: boolean; message?: string };
      if (!res.ok) throw new Error(body.message ?? "Không tắt được phiên nhận hoàn.");
      toast.success(
        body.still_held
          ? "Đã thoát. Bàn vẫn đang nhận hoàn vì còn nguồn khác giữ."
          : "Đã kết thúc. Đoạn video đang ghi dở sẽ được lưu nốt.",
      );
      setView(await readStatus(stationId));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (() => {
    if (view.heldByMe && !view.agentAcked) {
      return { text: "Máy chủ kho chưa nhận tín hiệu", tone: "bg-rose-100 text-rose-700" };
    }
    if (view.heldByMe) return { text: "Đang ghi cho hàng hoàn", tone: "bg-emerald-100 text-emerald-700" };
    if (view.state === "active") {
      return { text: "Bàn đang nhận hoàn (nguồn khác)", tone: "bg-amber-100 text-amber-800" };
    }
    if (view.state === "draining") {
      return { text: "Đang lưu nốt đoạn cuối", tone: "bg-sky-100 text-sky-700" };
    }
    return { text: "Chưa nhận hoàn", tone: "bg-slate-100 text-slate-600" };
  })();

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          disabled={busy || view.heldByMe}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
        >
          <option value="">— Chọn bàn nhận hoàn —</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
              {s.purpose === "return" ? " (chuyên hoàn)" : ""}
            </option>
          ))}
        </select>

        {view.heldByMe ? (
          <button
            onClick={stop}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            Kết thúc nhận hoàn
          </button>
        ) : (
          <button
            onClick={start}
            disabled={busy || !stationId}
            className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
            Bắt đầu nhận hoàn
          </button>
        )}

        <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusLabel.tone}`}>
          {statusLabel.text}
        </span>
      </div>

      <p className="mt-2 text-xs text-slate-500">
        Camera của bàn vẫn ghi liên tục cho đơn đi. Nút này đánh dấu đoạn video
        nào thuộc hàng hoàn — chỉ đoạn được đánh dấu mới giữ 7 ngày rồi xoá.
        Thoát trang thì đoạn đang ghi dở vẫn được lưu nốt.
      </p>
    </div>
  );
}
