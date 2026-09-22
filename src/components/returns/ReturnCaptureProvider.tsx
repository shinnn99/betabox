"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "@/components/ui/Toast";

/**
 * Giữ phiên nhận hoàn cho CẢ phân hệ hoàn hàng — nhiều bàn cùng lúc.
 *
 * Đặt ở layout của route group `(return-module)` — layout của Next.js không
 * bị dựng lại khi chuyển giữa các trang con, nên:
 *   - Giám sát hoàn hàng ⇄ Bằng chứng hoàn hàng: phiên vẫn giữ, nhịp vẫn chạy;
 *   - rời sang trang khác hoặc đóng tab: nhả MỌI bàn tab này đang giữ.
 *
 * Đợt 6 (21/09/2026): chủ dự án muốn mọi bàn nhận hoàn song song như luồng
 * đóng hàng. Một tab giữ được nhiều bàn; nhịp 30 giây gửi MỘT request cho
 * mọi bàn đang giữ thay vì mỗi bàn một request.
 *
 * Người giữ phiên tính theo TAB (`tabId` sinh mới mỗi lần tải trang): kho
 * hay dùng chung tài khoản cho mọi máy ở bàn, giữ theo tài khoản thì máy
 * này thoát là tắt phiên của máy kia. Không lưu tabId vào sessionStorage —
 * "Nhân bản tab" chép luôn sessionStorage và hai tab sẽ trùng người giữ.
 *
 * Tự bật (22/09/2026, sau khi bỏ thẻ QR): vào phân hệ là mọi bàn tự chuyển
 * sang nhận hoàn, trừ bàn người dùng đã bấm "Kết thúc" trên trình duyệt này
 * (để chạy lai: bàn 1-2 đóng hàng, bàn 3-4 nhận hoàn). Tài khoản không có
 * quyền thao tác (Viewer) thì server từ chối và tab này im lặng bỏ qua.
 *
 * Kế hoạch: plans/active/HOAN-HANG-song-song-moi-ban.md
 */

const HEARTBEAT_MS = 30_000;

/**
 * Bàn người dùng đã chủ động "Kết thúc" trên trình duyệt này — lần sau vào
 * phân hệ không tự bật lại. Nhớ bàn BỊ LOẠI (không nhớ bàn được chọn) để bàn
 * mới thêm vẫn tự bật như mặc định.
 */
const OPT_OUT_KEY = "betabox.returnCapture.optOut";

function readOptOut(): Set<string> {
  try {
    const raw = localStorage.getItem(OPT_OUT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeOptOut(ids: Set<string>) {
  try {
    localStorage.setItem(OPT_OUT_KEY, JSON.stringify([...ids]));
  } catch {
    // Trình duyệt chặn lưu trữ: lần sau tự bật lại mọi bàn, không sao.
  }
}

export type CaptureState = "none" | "active" | "draining" | "finished" | "abandoned";

export interface CaptureView {
  state: CaptureState;
  heldByMe: boolean;
  /** Số nguồn đang giữ bàn (các tab đang mở phân hệ) — kể cả tab này. */
  holderCount: number;
  agentAcked: boolean;
}

export interface StationOption {
  id: string;
  code: string;
  name: string;
  purpose: string | null;
  capture: CaptureView;
}

const IDLE: CaptureView = { state: "none", heldByMe: false, holderCount: 0, agentAcked: false };

interface CaptureContextValue {
  stations: StationOption[];
  /** Bàn tab này đang giữ. */
  heldIds: string[];
  /** Bàn đang có thao tác chờ server trả lời. */
  busyIds: Set<string>;
  start: (stationIds: string[]) => Promise<void>;
  stop: (stationIds: string[]) => Promise<void>;
}

const CaptureContext = createContext<CaptureContextValue | null>(null);

export function useReturnCapture(): CaptureContextValue {
  const ctx = useContext(CaptureContext);
  if (!ctx) throw new Error("useReturnCapture phải nằm trong ReturnCaptureProvider");
  return ctx;
}

interface RawCapture {
  state?: CaptureState;
  held_by_me?: boolean;
  holder_count?: number;
  agent_acked?: boolean;
}

function toView(raw: RawCapture | undefined): CaptureView {
  if (!raw) return IDLE;
  return {
    state: raw.state ?? "none",
    heldByMe: Boolean(raw.held_by_me),
    holderCount: raw.holder_count ?? 0,
    agentAcked: Boolean(raw.agent_acked),
  };
}

function newTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function ReturnCaptureProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [tabId] = useState(newTabId);
  const [stations, setStations] = useState<StationOption[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const heldIds = useMemo(
    () => stations.filter((s) => s.capture.heldByMe).map((s) => s.id),
    [stations],
  );

  // Tín hiệu đóng lúc rời phân hệ chạy ngoài vòng render nên đọc giá trị
  // mới nhất qua ref. Gán trong effect, không gán khi render.
  const heldRef = useRef<string[]>([]);
  useEffect(() => {
    heldRef.current = heldIds;
  }, [heldIds]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/returns/capture?tab_id=${encodeURIComponent(tabId)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        stations?: Array<{ id: string; code: string; name: string; purpose: string | null; capture?: RawCapture }>;
      };
      setStations(
        (body.stations ?? []).map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          purpose: s.purpose,
          capture: toView(s.capture),
        })),
      );
    } catch {
      // Mất mạng: giữ nguyên màn hình. Cloud tự nhả sau 2 phút.
    }
  }, [tabId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Nhịp: gia hạn mọi bàn đang giữ trong MỘT request, rồi đọc lại trạng thái
  // cả kho (thấy được bàn do tab khác bật).
  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        const held = heldRef.current;
        if (held.length > 0) {
          try {
            await fetch("/api/returns/capture", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ station_ids: held, action: "heartbeat", tab_id: tabId }),
            });
          } catch {
            // Mất mạng: thử lại nhịp sau. Cloud tự nhả sau 2 phút.
          }
        }
        await refresh();
      })();
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [refresh, tabId]);

  // Rời phân hệ / đóng tab: nhả mọi bàn đang giữ bằng MỘT tín hiệu.
  // sendBeacon vì fetch thường bị huỷ khi trang unload.
  useEffect(() => {
    const closeBeacon = () => {
      const held = heldRef.current;
      if (held.length === 0) return;
      const payload = JSON.stringify({ station_ids: held, action: "close", tab_id: tabId });
      navigator.sendBeacon("/api/returns/capture", new Blob([payload], { type: "application/json" }));
      heldRef.current = [];
    };
    window.addEventListener("pagehide", closeBeacon);
    return () => {
      window.removeEventListener("pagehide", closeBeacon);
      closeBeacon();
    };
  }, [tabId]);

  const run = useCallback(
    async (stationIds: string[], action: "open" | "close", auto = false) => {
      if (stationIds.length === 0) return;
      setBusyIds((prev) => new Set([...prev, ...stationIds]));
      try {
        const res = await fetch("/api/returns/capture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ station_ids: stationIds, action, tab_id: tabId }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          results?: Array<{
            station_id: string;
            ok: boolean;
            error?: string;
            camera_count?: number;
            agent_notified?: boolean;
            still_held?: boolean;
          }>;
        };
        // Tự bật mà tài khoản không có quyền thao tác (Viewer): im lặng.
        if (auto && res.status === 403) return;
        if (!res.ok || !body.results) {
          throw new Error(body.message ?? "Máy chủ không phản hồi đúng.");
        }

        const codeOf = (id: string) => stations.find((s) => s.id === id)?.code ?? id.slice(0, 8);
        const failed = body.results.filter((r) => !r.ok);
        const noCamera = body.results.filter((r) => r.ok && action === "open" && (r.camera_count ?? 0) === 0);
        const notNotified = body.results.filter(
          (r) => r.ok && action === "open" && (r.camera_count ?? 0) > 0 && !r.agent_notified,
        );
        const stillHeld = body.results.filter((r) => r.ok && action === "close" && r.still_held);
        const okCount = body.results.length - failed.length;

        if (okCount > 0) {
          toast.success(
            action === "open"
              ? `${auto ? "Đã tự chuyển" : "Đã bật"} nhận hoàn ở ${okCount} bàn.`
              : `Đã kết thúc nhận hoàn ở ${okCount} bàn. Đoạn video đang ghi dở sẽ được lưu nốt.`,
          );
        }
        if (failed.length > 0) {
          toast.error(`Không thực hiện được ở ${failed.map((r) => codeOf(r.station_id)).join(", ")}.`);
        }
        if (noCamera.length > 0) {
          toast.error(`${noCamera.map((r) => codeOf(r.station_id)).join(", ")} chưa gắn camera — sẽ không có video kiện hoàn.`);
        }
        if (notNotified.length > 0) {
          toast.error("Chưa gửi được tín hiệu cho máy chủ kho. Video chưa được đánh dấu.");
        }
        if (stillHeld.length > 0) {
          toast.info(
            `${stillHeld.map((r) => codeOf(r.station_id)).join(", ")} vẫn đang nhận hoàn vì còn máy khác đang mở trang Hàng hoàn.`,
          );
        }
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          for (const id of stationIds) next.delete(id);
          return next;
        });
        await refresh();
      }
    },
    [refresh, stations, tabId, toast],
  );

  const start = useCallback(
    (ids: string[]) => {
      const optOut = readOptOut();
      for (const id of ids) optOut.delete(id);
      writeOptOut(optOut);
      return run(ids, "open");
    },
    [run],
  );
  const stop = useCallback(
    (ids: string[]) => {
      const optOut = readOptOut();
      for (const id of ids) optOut.add(id);
      writeOptOut(optOut);
      return run(ids, "close");
    },
    [run],
  );

  // Vào phân hệ là tự chuyển sang nhận hoàn — MỘT lần mỗi lần vào, ngay khi
  // biết danh sách bàn. Rời phân hệ thì tín hiệu đóng ở trên nhả hết.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || stations.length === 0) return;
    autoStarted.current = true;
    const optOut = readOptOut();
    const ids = stations.filter((s) => !s.capture.heldByMe && !optOut.has(s.id)).map((s) => s.id);
    void run(ids, "open", true);
  }, [stations, run]);

  const value = useMemo(
    () => ({ stations, heldIds, busyIds, start, stop }),
    [stations, heldIds, busyIds, start, stop],
  );

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}
