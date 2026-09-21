"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "@/components/ui/Toast";

/**
 * Giữ phiên nhận hoàn cho CẢ phân hệ hoàn hàng.
 *
 * Đặt ở layout của route group `(return-module)` — layout của Next.js không
 * bị dựng lại khi chuyển giữa các trang con, nên:
 *   - Giám sát hoàn hàng ⇄ Bằng chứng hoàn hàng: phiên vẫn giữ, nhịp vẫn chạy;
 *   - rời sang trang khác hoặc đóng tab: gửi tín hiệu đóng — đúng nghĩa
 *     "thoát khỏi giao diện hoàn hàng" mà chủ dự án chốt.
 *
 * Nếu để nhịp trong từng trang thì mỗi lần bấm sang trang hoàn hàng kia là
 * một lần đóng rồi mở phiên — agent nhận TẮT/BẬT liên tục và đoạn video ở
 * giữa bị chia cho hai phiên.
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md,
 * plans/active/HOAN-HANG-giao-dien-giam-sat-bang-chung.md
 */

const STORAGE_KEY = "betabox.returns.capture-station";
const HEARTBEAT_MS = 30_000;

export interface StationOption {
  id: string;
  code: string;
  name: string;
  purpose: string | null;
}

export type CaptureState = "none" | "active" | "draining" | "finished" | "abandoned";

export interface CaptureView {
  state: CaptureState;
  heldByMe: boolean;
  agentAcked: boolean;
}

const IDLE: CaptureView = { state: "none", heldByMe: false, agentAcked: false };

interface CaptureContextValue {
  stations: StationOption[];
  stationId: string;
  setStationId: (id: string) => void;
  view: CaptureView;
  busy: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const CaptureContext = createContext<CaptureContextValue | null>(null);

export function useReturnCapture(): CaptureContextValue {
  const ctx = useContext(CaptureContext);
  if (!ctx) throw new Error("useReturnCapture phải nằm trong ReturnCaptureProvider");
  return ctx;
}

async function readStatus(id: string): Promise<CaptureView> {
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
}

export default function ReturnCaptureProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [stations, setStations] = useState<StationOption[]>([]);
  const [stationId, setStationId] = useState("");
  const [view, setView] = useState<CaptureView>(IDLE);
  const [busy, setBusy] = useState(false);

  // Tín hiệu đóng lúc rời phân hệ chạy ngoài vòng render nên đọc giá trị
  // mới nhất qua ref. Gán trong effect, không gán khi render.
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
  }, [stationId]);

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

  // Rời phân hệ / đóng tab: gửi tín hiệu đóng. sendBeacon vì fetch thường
  // bị huỷ khi trang unload.
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

  const start = useCallback(async () => {
    if (!stationId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/returns/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ station_id: stationId, action: "open" }),
      });
      const body = (await res.json()) as {
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
  }, [stationId, toast]);

  const stop = useCallback(async () => {
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
  }, [stationId, toast]);

  return (
    <CaptureContext.Provider
      value={{ stations, stationId, setStationId, view, busy, start, stop }}
    >
      {children}
    </CaptureContext.Provider>
  );
}
