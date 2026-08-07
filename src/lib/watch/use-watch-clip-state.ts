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
/**
 * Nhịp poll khi đơn còn đang đóng gói. Chậm hơn active (không có gì để
 * chờ ở phía agent) nhưng nhanh hơn offline — đơn đóng bằng scan kế
 * thường trong vài chục giây tới vài phút, user không nên phải đợi thêm
 * 20s nữa mới thấy clip bắt đầu cắt.
 */
const ORDER_OPEN_POLL_INTERVAL_MS = 5000;

export type WatchClipState =
  | "idle"
  | "preparing_cut"
  | "ready"
  | "failed"
  | "warehouse_offline"
  | "offline_giveup"
  | "network_error"
  /**
   * Đơn chưa đóng (packing_events.timing_status='open'). KHÔNG cắt clip ở
   * trạng thái này — biên clip chưa xác định, cắt bây giờ sẽ ra clip cụt
   * 60s và bị lưu làm bằng chứng. Poll tiếp ở nhịp chậm: đơn đóng xong
   * (scan kế / ra ca) là tick sau tự chuyển sang preparing_cut.
   */
  | "order_open";

export type RegenerationState = "encoding" | "uploading";

interface WatchApiResponse {
  state:
    | "preparing_cut"
    | "ready"
    | "failed"
    | "warehouse_offline"
    | "offline_giveup"
    | "order_open";
  signed_url?: string;
  expires_at?: string;
  regenerating?: boolean;
  regeneration_state?: RegenerationState;
  regeneration_error?: string;
  error?: string;
  offline_duration_seconds?: number;
  open_duration_seconds?: number;
}

export interface UseWatchClipStateResult {
  state: WatchClipState;
  signedUrl: string | null;
  errorMessage: string | null;
  offlineDurationSeconds: number | null;
  /** Chỉ có khi state=order_open: đơn đã mở bao nhiêu giây. */
  openDurationSeconds: number | null;
  elapsedSeconds: number;
  /** Safe-retry: đang regenerate song song với ready cũ. */
  regenerating: boolean;
  regenerationState: RegenerationState | null;
  /** Safe-retry: lần regenerate cuối cùng failed nhưng ready cũ vẫn còn. */
  regenerationError: string | null;
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
  const [openDurationSeconds, setOpenDurationSeconds] = useState<number | null>(
    null,
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerationState, setRegenerationState] =
    useState<RegenerationState | null>(null);
  const [regenerationError, setRegenerationError] = useState<string | null>(
    null,
  );

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
        // Safe-retry: state kép — nếu backend báo đang regenerate,
        // TIẾP TỤC poll để bắt được ready mới sau khi promote. UI
        // vẫn phát signed_url cũ trong lúc chờ.
        if (data.regenerating) {
          setRegenerating(true);
          setRegenerationState(data.regeneration_state ?? null);
          setRegenerationError(null);
          schedule(ACTIVE_POLL_INTERVAL_MS, () => void tick());
          return;
        }
        setRegenerating(false);
        setRegenerationState(null);
        // Nếu regeneration_error đến (retry vừa fail nhưng ready cũ
        // vẫn còn), hiện cảnh báo — KHÔNG stop poll để user thấy
        // ngay khi họ retry lại.
        setRegenerationError(data.regeneration_error ?? null);
        // Stop poll cho state ready terminal (không có regenerating,
        // không có regeneration_error). Nếu regeneration_error có,
        // GIỮ poll để user bấm retry lại.
        if (!data.regeneration_error) stop();
        return;
      }
      if (data.state === "failed") {
        setState("failed");
        setErrorMessage(data.error ?? "unknown");
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
      if (data.state === "order_open") {
        // Đơn chưa đóng — server không enqueue cut. KHÔNG stop poll: khi
        // đơn đóng, tick kế nhận preparing_cut và chạy tiếp bình thường.
        setState("order_open");
        setOpenDurationSeconds(data.open_duration_seconds ?? null);
        setOfflineDurationSeconds(null);
        setRegenerating(false);
        setRegenerationState(null);
        // Màn hình order_open đã nói đủ lý do; giữ thêm regenerationError
        // chỉ tạo hai thông điệp chồng nhau cho cùng một chuyện.
        setRegenerationError(null);
        // Dời mốc elapsed theo từng tick: thời gian chờ đơn đóng KHÔNG
        // phải thời gian cắt clip. Nếu không dời, lúc chuyển sang
        // preparing_cut counter sẽ nhảy vào "Đang tải clip... 240s".
        startedAtRef.current = Date.now();
        schedule(ORDER_OPEN_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      if (data.state === "preparing_cut") {
        setState("preparing_cut");
        setOfflineDurationSeconds(null);
        setOpenDurationSeconds(null);
        setRegenerating(false);
        setRegenerationState(null);
        schedule(ACTIVE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      // Backend state không nằm trong union — poll tiếp cho an toàn.
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
    setOpenDurationSeconds(null);
    setRegenerating(false);
    setRegenerationState(null);
    setRegenerationError(null);
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    void tick();
  }, [tick]);

  const retry = useCallback(async () => {
    // Safe-retry S7: server KHÔNG wipe row + bucket cũ. Endpoint retry
    // enqueue generation MỚI song song với ready cũ (nếu có). /watch
    // tick kế sẽ thấy state kép ready + regenerating=true.
    try {
      const res = await fetch(`/api/order-proof/${peId}/watch/retry`, {
        method: "POST",
        cache: "no-store",
      });
      // 409 = server KHÔNG enqueue được. Hai lý do khác nhau hẳn, phải
      // đọc body để báo đúng: agent offline (chờ mạng) vs đơn chưa đóng
      // (chờ nghiệp vụ). Báo nhầm "kho offline" khi kho vẫn online sẽ
      // đẩy người dùng đi kiểm tra sai chỗ.
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          message?: string;
        } | null;
        setRegenerationError(
          body?.error === "order_still_open"
            ? (body.message ??
              "Đơn đang được đóng gói, chưa cắt được clip đầy đủ.")
            : "Kho đang offline, thử lại sau khi có kết nối.",
        );
        // VẪN kick tick dù không enqueue được. /watch là nguồn chân lý
        // cho màn hình hiển thị, còn retry chỉ là hành động.
        //
        // Không kick thì lối vào mode='generate' (modal tự gọi retry lúc
        // mount, không qua nút bấm) đứng nguyên ở state 'idle' → rơi vào
        // fallback "Trạng thái chưa xác định", bấm Thử lại lại 409 →
        // ngõ cụt. Kick tick thì /watch trả order_open hoặc
        // warehouse_offline và user thấy đúng lý do.
        schedule(0, () => void tick());
        return;
      }
    } catch (err) {
      console.warn("retry failed:", err);
    }
    if (!activeRef.current) return;
    // Reset elapsed (mới bắt đầu chờ). Nếu đang ở state ready + regenerating,
    // KHÔNG mất signed_url — tick kế /watch sẽ trả ready + regenerating=true
    // với cùng URL cũ.
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setRegenerationError(null);
    // Nếu đang state terminal (failed/offline_giveup), khôi phục poll.
    if (
      state === "failed" ||
      state === "offline_giveup" ||
      state === "network_error"
    ) {
      setState("preparing_cut");
      setSignedUrl(null);
      setErrorMessage(null);
      setOfflineDurationSeconds(null);
    }
    // Kick tick ngay — nếu poll đang chạy (state ready + regen), schedule
    // gọi tick sớm, không double-tick vì schedule tự clearTimeout.
    schedule(0, () => void tick());
  }, [peId, tick, schedule, state]);

  // Elapsed timer khi đang preparing hoặc đang regenerating.
  useEffect(() => {
    const shouldTick =
      state === "preparing_cut" ||
      (state === "ready" && regenerating);
    if (!shouldTick) return;
    const id = setInterval(() => {
      if (startedAtRef.current) {
        setElapsedSeconds(
          Math.floor((Date.now() - startedAtRef.current) / 1000),
        );
      }
    }, 1000);
    return () => clearInterval(id);
  }, [state, regenerating]);

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
    openDurationSeconds,
    elapsedSeconds,
    regenerating,
    regenerationState,
    regenerationError,
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
