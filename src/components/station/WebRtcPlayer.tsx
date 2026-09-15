"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, WifiOff } from "lucide-react";

type PlayerState = "connecting" | "playing" | "failed";

async function waitForIceGathering(
  peer: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    let timeout = 0;
    const finish = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal.removeEventListener("abort", onAbort);
    };
    const onChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      finish();
      resolve();
    };
    const onAbort = () => {
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    };
    peer.addEventListener("icegatheringstatechange", onChange);
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = window.setTimeout(() => {
      finish();
      resolve();
    }, 3_000);
  });
}

export default function WebRtcPlayer({
  endpoint,
  label,
  className = "",
}: {
  endpoint: string;
  label: string;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PlayerState>("connecting");
  const [message, setMessage] = useState("Đang kết nối camera...");

  useEffect(() => {
    const abort = new AbortController();
    const peer = new RTCPeerConnection();
    const video = videoRef.current;
    let sessionUrl: string | null = null;
    let reconnectTimer = 0;
    let retryScheduled = false;

    const fail = (reason: string) => {
      if (abort.signal.aborted || retryScheduled) return;
      retryScheduled = true;
      setState("failed");
      setMessage(reason);
      reconnectTimer = window.setTimeout(
        () => setAttempt((value) => value + 1),
        5_000,
      );
    };

    peer.addTransceiver("video", { direction: "recvonly" });
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (video) video.srcObject = stream;
    };
    peer.onconnectionstatechange = () => {
      if (abort.signal.aborted) return;
      if (peer.connectionState === "connected") {
        setState("playing");
        setMessage("");
      } else if (
        peer.connectionState === "failed" ||
        peer.connectionState === "disconnected"
      ) {
        fail("Mất kết nối camera. Hệ thống đang thử lại...");
      }
    };

    void (async () => {
      try {
        setState("connecting");
        setMessage("Đang kết nối camera...");
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer, abort.signal);
        const localSdp = peer.localDescription?.sdp;
        if (!localSdp) throw new Error("Không tạo được phiên WebRTC");

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: localSdp,
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`MediaMTX từ chối kết nối (${response.status})`);
        }
        const location = response.headers.get("location");
        if (location) sessionUrl = new URL(location, endpoint).toString();
        const answerSdp = await response.text();
        await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          fail(
            error instanceof TypeError
              ? "Không truy cập được bộ phát video trên máy bàn."
              : (error as Error).message,
          );
        }
      }
    })();

    return () => {
      abort.abort();
      window.clearTimeout(reconnectTimer);
      const stream = video?.srcObject;
      if (stream instanceof MediaStream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (video) video.srcObject = null;
      peer.close();
      if (sessionUrl) {
        void fetch(sessionUrl, { method: "DELETE", keepalive: true }).catch(
          () => undefined,
        );
      }
    };
  }, [endpoint, attempt]);

  return (
    <div className={`overflow-hidden bg-slate-950 ${className}`}>
      <video
        ref={videoRef}
        aria-label={label}
        autoPlay
        muted
        playsInline
        className="h-full w-full object-contain"
      >
        Trình duyệt không hỗ trợ video trực tiếp.
      </video>
      {state !== "playing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/90 px-4 text-center text-white">
          {state === "connecting" ? (
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
          ) : (
            <WifiOff className="h-6 w-6 text-amber-400" />
          )}
          <p className="text-xs text-slate-200">{message}</p>
          {state === "failed" && (
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/15"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Thử lại
            </button>
          )}
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}
