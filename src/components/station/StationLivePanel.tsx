"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import LiveLayout, { type LiveCameraSource } from "./LiveLayout";

interface LiveResponse {
  station: { id: string; code: string; name: string };
  viewer_scope: "admin" | "station";
  transport: "local_webrtc";
  cameras: {
    overview: LiveCameraSource | null;
    qr: LiveCameraSource | null;
  };
}

interface StationEventResponse {
  event: {
    id: string;
    occurred_at: string;
    level: "success" | "warning" | "error";
    message: string;
  } | null;
}

export default function StationLivePanel({ stationId }: { stationId: string }) {
  const toast = useToast();
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastEventId = useRef<string | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  // Browser audio must be unlocked by a user gesture. We keep the tone local
  // to the viewer; the agent recording/QR pipeline keeps running even when the
  // live panel is closed or remounted.
  const playAcknowledgedSound = useCallback(() => {
    const context = audioContext.current ?? new window.AudioContext();
    audioContext.current = context;
    if (context.state !== "running") return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.17);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/live/${stationId}`, {
        cache: "no-store",
        signal,
      });
      const body = (await response.json().catch(() => null)) as
        | (LiveResponse & { message?: string })
        | { message?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.message ?? "Không tải được cấu hình camera của bàn.");
      }
      setData(body as LiveResponse);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setData(null);
        setError((loadError as Error).message);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [stationId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    const unlockAudio = () => {
      const context = audioContext.current ?? new window.AudioContext();
      audioContext.current = context;
      void context.resume();
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      const context = audioContext.current;
      audioContext.current = null;
      if (context) void context.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Lightweight polling is used here instead of keeping another WebSocket/SSE
    // channel alive beside WHEP. Missing one poll is acceptable because the
    // next poll rechecks the latest station event.
    const poll = async () => {
      try {
        const response = await fetch(`/api/live/${stationId}/events`, {
          cache: "no-store",
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as StationEventResponse;
        if (!body.event) return;
        if (lastEventId.current === null) {
          lastEventId.current = body.event.id;
          return;
        }
        if (body.event.id === lastEventId.current) return;
        lastEventId.current = body.event.id;
        if (body.event.level === "success") {
          toast.success(body.event.message);
          playAcknowledgedSound();
        } else if (body.event.level === "warning") {
          toast.info(body.event.message);
        } else {
          toast.error(body.event.message);
        }
      } catch {
        // The next poll retries without interrupting the live video.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [playAcknowledgedSound, stationId, toast]);

  if (loading) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-xl bg-slate-950 text-white">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-emerald-400" />
        <span className="text-sm">Đang tải hai camera...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-5 text-center text-amber-800">
        <AlertTriangle className="h-6 w-6" />
        <p className="text-sm font-semibold">Chưa mở được màn hình trực tiếp</p>
        <p className="max-w-lg text-xs">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-amber-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Tải lại
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <LiveLayout
        stationLabel={`${data.station.code} · ${data.station.name}`}
        overview={data.cameras.overview}
        qr={data.cameras.qr}
      />
      <p className="text-[11px] text-slate-500">
        Video đi trực tiếp từ bộ phát MediaMTX trên máy bàn; hệ thống cloud không nhận mật khẩu camera.
      </p>
    </div>
  );
}
