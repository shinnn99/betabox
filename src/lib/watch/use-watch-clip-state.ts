"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * State machine 3c/3d dùng chung cho MỌI chỗ xem clip trong app.
 *
 * Trước đây có trang riêng `/dashboard/orders/[pe_id]/watch` để user
 * theo dõi tiến độ; nhưng UX yêu cầu "một cửa trong list, không nhảy
 * tab" — hook này gom toàn bộ state machine + poll vào một chỗ, mọi
 * caller (modal ở list, deep-link tương lai nếu có) đều dùng.
 *
 * KHÔNG có "hai luồng poll song song" — vì trang detail đã xóa. "Nơi
 * poll duy nhất" chuyển từ trang sang hook này. Nguyên tắc một-nguồn
 * giữ nguyên, chỉ đổi vị trí.
 *
 * Không viết logic ở nơi khác — nếu cần xem/tạo/tải-lại clip ở chỗ nào
 * mới, IMPORT hook này, đừng chép. Chép logic = sót nhánh (offline_giveup,
 * cleanup timer, elapsed reset khi retry) = bug modal-treo.
 *
 * Contract:
 *   - `start()`: kick tick đầu tiên. Idempotent (đang chạy = no-op).
 *   - `retry()`: gọi /watch/retry (xóa row + bucket) rồi kick lại tick.
 *   - `stop()`: dừng poll, giữ state cuối. Gọi khi user đóng UI hoặc
 *     component unmount. Cleanup timer.
 *   - `state`: nhánh hiện tại.
 *   - `signedUrl`: chỉ có khi state=ready.
 *   - `errorMessage`: có khi state=failed|upload_failed|network_error.
 *   - `offlineDurationSeconds`: server tính, không phải client tự đếm.
 *   - `elapsedSeconds`: đếm khi state=preparing_*. Reset khi start/retry.
 *
 * Poll interval + offline threshold dùng chung từ src/lib/watch/config
 * qua endpoint /watch (server đọc constant, client không cần biết
 * threshold — chỉ biết poll cadence). Cadence hardcode ở hook vì
 * client cadence độc lập server threshold (cadence 2s/20s là UX
 * choice, không phải business rule). Nếu đổi, đổi 2 hằng ở dưới.
 */

const ACTIVE_POLL_INTERVAL_MS = 2000;
const OFFLINE_POLL_INTERVAL_MS = 20000;

export type WatchClipState =
  | "idle"
  | "preparing_cut"
  | "preparing_upload"
  | "ready"
  | "failed"
  | "upload_failed"
  | "warehouse_offline"
  | "offline_giveup"
  | "network_error";

interface WatchApiResponse {
  state:
    | "preparing_cut"
    | "preparing_upload"
    | "ready"
    | "failed"
    | "upload_failed"
    | "warehouse_offline"
    | "offline_giveup"
    | "unknown";
  signed_url?: string;
  expires_at?: string;
  error?: string;
  offline_duration_seconds?: number;
}

export interface UseWatchClipStateResult {
  state: WatchClipState;
  signedUrl: string | null;
  errorMessage: string | null;
  offlineDurationSeconds: number | null;
  elapsedSeconds: number;
  start: () => void;
  retry: () => Promise<void>;
  stop: () => void;
}

export function useWatchClipState(peId: string): UseWatchClipStateResult {
  const [state, setState] = useState<WatchClipState>("idle");
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [offlineDurationSeconds, setOfflineDurationSeconds] = useState<
    number | null
  >(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  // Guard chống setState sau unmount — user đóng modal giữa lúc fetch
  // đang chờ response.
  const activeRef = useRef(true);

  const stop = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // setTimeout đệ quy để đổi interval theo state (2s active, 20s offline).
  // setInterval không đổi giữa chừng được.
  const schedule = useCallback((delayMs: number, fn: () => void) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(fn, delayMs);
  }, []);

  const tick = useCallback(async () => {
    try {
      const res = await fetch(`/api/order-proof/${peId}/watch`, {
        method: "POST",
        cache: "no-store",
      });
      const data = (await res.json()) as WatchApiResponse;
      if (!activeRef.current) return;

      if (data.state === "ready" && data.signed_url) {
        setSignedUrl(data.signed_url);
        setState("ready");
        setErrorMessage(null);
        setOfflineDurationSeconds(null);
        stop();
        return;
      }
      if (data.state === "failed") {
        setState("failed");
        setErrorMessage(data.error ?? "unknown");
        stop();
        return;
      }
      if (data.state === "upload_failed") {
        setState("upload_failed");
        setErrorMessage(data.error ?? "upload_failed");
        stop();
        return;
      }
      if (data.state === "offline_giveup") {
        setState("offline_giveup");
        setOfflineDurationSeconds(data.offline_duration_seconds ?? null);
        stop();
        return;
      }
      if (data.state === "warehouse_offline") {
        setState("warehouse_offline");
        setOfflineDurationSeconds(data.offline_duration_seconds ?? null);
        schedule(OFFLINE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      if (data.state === "preparing_cut") {
        setState("preparing_cut");
        setOfflineDurationSeconds(null);
        schedule(ACTIVE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      if (data.state === "preparing_upload") {
        setState("preparing_upload");
        setOfflineDurationSeconds(null);
        schedule(ACTIVE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      // unknown → tick lại active (server chưa quyết state → cho một
      // nhịp nữa, không stop). Đây là hố an toàn: nếu backend bổ sung
      // state mới mà quên map, hook không treo — vẫn poll.
      schedule(ACTIVE_POLL_INTERVAL_MS, () => void tick());
    } catch (err) {
      if (!activeRef.current) return;
      // Network hiccup — KHÔNG stop, KHÔNG dồn thành terminal state.
      // Thử lại sau nhịp active. Nếu server chết dài hạn, user sẽ
      // đóng modal — activeRef=false chặn setState.
      console.warn("watch poll failed:", err);
      schedule(ACTIVE_POLL_INTERVAL_MS, () => void tick());
    }
  }, [peId, stop, schedule]);

  const start = useCallback(() => {
    // Idempotent: đang chạy timer = no-op để tránh double-tick.
    if (pollTimerRef.current) return;
    setState("preparing_cut");
    setErrorMessage(null);
    setSignedUrl(null);
    setOfflineDurationSeconds(null);
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    void tick();
  }, [tick]);

  const retry = useCallback(async () => {
    // Server xóa row + bucket → tick kế thấy unknown → enqueue cut lại.
    // User-driven, không auto-retry server-side (chống loop).
    try {
      await fetch(`/api/order-proof/${peId}/watch/retry`, {
        method: "POST",
        cache: "no-store",
      });
    } catch (err) {
      console.warn("retry failed:", err);
    }
    if (!activeRef.current) return;
    // Reset state như start(), nhưng KHÔNG check pollTimerRef —
    // retry được gọi từ state terminal (failed/upload_failed), timer
    // đã stop rồi.
    stop();
    setState("preparing_cut");
    setErrorMessage(null);
    setSignedUrl(null);
    setOfflineDurationSeconds(null);
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    void tick();
  }, [peId, tick, stop]);

  // Elapsed timer khi đang preparing. KHÔNG chạy khi warehouse_offline
  // (offline_duration_seconds từ server) hoặc terminal (không còn ý
  // nghĩa "đã chờ bao lâu").
  useEffect(() => {
    if (state !== "preparing_cut" && state !== "preparing_upload") return;
    const id = setInterval(() => {
      if (startedAtRef.current) {
        setElapsedSeconds(
          Math.floor((Date.now() - startedAtRef.current) / 1000),
        );
      }
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  // Cleanup khi component unmount hoặc peId đổi.
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [peId]);

  return {
    state,
    signedUrl,
    errorMessage,
    offlineDurationSeconds,
    elapsedSeconds,
    start,
    retry,
    stop,
  };
}

/**
 * Format offline_duration_seconds thành text người đọc.
 * Dùng chung modal + badge — đừng chép công thức ra chỗ khác.
 */
export function formatOfflineDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
