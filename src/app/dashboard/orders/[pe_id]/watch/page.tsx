"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

/**
 * 3c + 3d: trang xem clip đơn X.
 *
 * State machine ở SERVER. Client CHỈ:
 *   1. Bấm "Xem clip" → gọi POST /api/order-proof/[pe_id]/watch lần đầu.
 *   2. Poll POST /watch — 2s ở state active, 20s ở warehouse_offline.
 *   3. Khi state='ready' → set signed_url vào <video>, NGỪNG poll.
 *   4. Khi state='failed' | 'upload_failed' | 'offline_giveup' → NGỪNG
 *      poll, hiện UI tương ứng.
 *
 * 3d — offline handling:
 *   - warehouse_offline: agent kho offline, poll giãn 20s, hiện thời gian
 *     kho offline (server tính từ last_seen_at), KHÔNG có nút retry.
 *   - offline_giveup: server đã quyết giveup (kho offline vượt ngưỡng).
 *     Dừng poll, hiện link tải lại trang (không phải retry ảo).
 *
 * Client KHÔNG tự tính "đã chờ bao lâu" cho giveup — tất cả từ server
 * (tránh bug: reload trốn giveup, mở tab muộn chờ oan).
 */
type WatchState =
  | "idle"
  | "preparing_cut"
  | "preparing_upload"
  | "ready"
  | "failed"
  | "upload_failed"
  | "warehouse_offline"
  | "offline_giveup";

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

const ACTIVE_POLL_INTERVAL_MS = 2000;
const OFFLINE_POLL_INTERVAL_MS = 20000;

/**
 * Format offline_duration_seconds thành text người đọc.
 *   < 60s   → "vừa mới đây"
 *   < 3600s → "X phút"
 *   >= 3600s → "Xh Ym"
 */
function formatOfflineDuration(seconds: number): string {
  if (seconds < 60) return "vừa mới đây";
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} phút`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function OrderWatchPage() {
  const params = useParams<{ pe_id: string }>();
  const peId = params.pe_id;

  const [state, setState] = useState<WatchState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [offlineDurationSec, setOfflineDurationSec] = useState<number | null>(
    null,
  );
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // schedulePoll dùng setTimeout đệ quy để đổi interval theo state
  // (2s active, 20s offline). setInterval không đổi giữa chừng được.
  const schedulePoll = useCallback((delayMs: number, fn: () => void) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(fn, delayMs);
  }, []);

  const tick = useCallback(async () => {
    try {
      const res = await fetch(`/api/order-proof/${peId}/watch`, {
        method: "POST",
      });
      const data = (await res.json()) as WatchApiResponse;

      if (data.state === "ready" && data.signed_url) {
        setSignedUrl(data.signed_url);
        setState("ready");
        setErrorMsg(null);
        setOfflineDurationSec(null);
        stopPolling();
        return;
      }
      if (data.state === "failed") {
        setState("failed");
        setErrorMsg(data.error ?? "unknown");
        stopPolling();
        return;
      }
      if (data.state === "upload_failed") {
        setState("upload_failed");
        setErrorMsg(data.error ?? "upload_failed");
        stopPolling();
        return;
      }
      if (data.state === "offline_giveup") {
        setState("offline_giveup");
        setOfflineDurationSec(data.offline_duration_seconds ?? null);
        stopPolling();
        return;
      }
      if (data.state === "warehouse_offline") {
        setState("warehouse_offline");
        setOfflineDurationSec(data.offline_duration_seconds ?? null);
        schedulePoll(OFFLINE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      if (data.state === "preparing_cut") {
        setState("preparing_cut");
        setOfflineDurationSec(null);
        schedulePoll(ACTIVE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      if (data.state === "preparing_upload") {
        setState("preparing_upload");
        setOfflineDurationSec(null);
        schedulePoll(ACTIVE_POLL_INTERVAL_MS, () => void tick());
        return;
      }
      // unknown → giữ state hiện tại, poll tiếp active
      schedulePoll(ACTIVE_POLL_INTERVAL_MS, () => void tick());
    } catch (err) {
      // Network hiccup — không dừng, thử lại tick sau (active interval)
      console.warn("watch poll failed:", err);
      schedulePoll(ACTIVE_POLL_INTERVAL_MS, () => void tick());
    }
  }, [peId, stopPolling, schedulePoll]);

  const startWatch = useCallback(() => {
    setState("preparing_cut");
    setErrorMsg(null);
    setSignedUrl(null);
    setOfflineDurationSec(null);
    startedAtRef.current = Date.now();
    setElapsedSec(0);
    void tick();
  }, [tick]);

  const retry = useCallback(async () => {
    try {
      await fetch(`/api/order-proof/${peId}/watch/retry`, {
        method: "POST",
      });
    } catch (err) {
      console.warn("retry failed:", err);
    }
    startWatch();
  }, [peId, startWatch]);

  // Elapsed timer khi đang preparing (KHÔNG chạy trong warehouse_offline —
  // offline duration từ server, không phải "đã chờ bao lâu")
  useEffect(() => {
    if (state === "preparing_cut" || state === "preparing_upload") {
      const id = setInterval(() => {
        if (startedAtRef.current) {
          setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
        }
      }, 1000);
      return () => clearInterval(id);
    }
  }, [state]);

  // Cleanup khi unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 900 }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>Xem clip đơn</h1>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 24 }}>
        pe_id: <code>{peId}</code>
      </div>

      {state === "idle" && (
        <button
          onClick={startWatch}
          style={{
            padding: "10px 20px",
            fontSize: 16,
            background: "#0070f3",
            color: "white",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Xem clip
        </button>
      )}

      {(state === "preparing_cut" || state === "preparing_upload") && (
        <div style={{ padding: 16, background: "#fff8e1", borderRadius: 8 }}>
          <div style={{ fontSize: 16, marginBottom: 8 }}>
            {state === "preparing_cut"
              ? "Đang cắt clip..."
              : "Đang tải clip lên..."}
          </div>
          <div style={{ fontSize: 13, color: "#666" }}>
            Đã chờ {elapsedSec}s (thường 10–30s tổng)
          </div>
        </div>
      )}

      {state === "warehouse_offline" && (
        <div style={{ padding: 16, background: "#fff3e0", borderRadius: 8 }}>
          <div style={{ fontSize: 16, marginBottom: 8, color: "#e65100" }}>
            Kho đang offline
          </div>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>
            Clip đơn này lưu tại máy kho. Kho đang offline{" "}
            {offlineDurationSec !== null
              ? `(${formatOfflineDuration(offlineDurationSec)})`
              : ""}
            .
          </div>
          <div style={{ fontSize: 13, color: "#666" }}>
            Đang thử lại tự động khi kho online...
          </div>
        </div>
      )}

      {state === "offline_giveup" && (
        <div style={{ padding: 16, background: "#ffebee", borderRadius: 8 }}>
          <div style={{ fontSize: 16, marginBottom: 8, color: "#c62828" }}>
            Kho vẫn offline
          </div>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
            Kho đã offline{" "}
            {offlineDurationSec !== null
              ? formatOfflineDuration(offlineDurationSec)
              : ""}
            . Tải lại trang khi kho online lại.
          </div>
          <a
            href={typeof window !== "undefined" ? window.location.href : "#"}
            onClick={(e) => {
              e.preventDefault();
              window.location.reload();
            }}
            style={{
              display: "inline-block",
              padding: "8px 16px",
              fontSize: 14,
              background: "#c62828",
              color: "white",
              borderRadius: 6,
              textDecoration: "none",
            }}
          >
            Tải lại trang
          </a>
        </div>
      )}

      {state === "ready" && signedUrl && (
        <div>
          <video
            src={signedUrl}
            controls
            playsInline
            style={{ width: "100%", maxWidth: 800, borderRadius: 6 }}
          />
          <div style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
            Clip sẵn sàng. Signed URL hạn 45 phút — tải lại trang nếu hết hạn.
          </div>
        </div>
      )}

      {(state === "failed" || state === "upload_failed") && (
        <div
          style={{
            padding: 16,
            background: "#ffebee",
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 16, marginBottom: 8, color: "#c62828" }}>
            {state === "upload_failed"
              ? "Tải clip lên thất bại tạm thời"
              : "Không cắt được clip"}
          </div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 12 }}>
            Chi tiết: <code>{errorMsg}</code>
          </div>
          <button
            onClick={retry}
            style={{
              padding: "8px 16px",
              fontSize: 14,
              background: "#c62828",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Thử lại (cắt+upload từ đầu)
          </button>
        </div>
      )}
    </div>
  );
}
