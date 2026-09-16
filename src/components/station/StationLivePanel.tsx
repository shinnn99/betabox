"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Timer, Volume2, VolumeX } from "lucide-react";
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

type AnnouncementLevel = "success" | "warning" | "error";

interface StationEventResponse {
  event: {
    id: string;
    occurred_at: string;
    level: AnnouncementLevel;
    message: string;
    /** Câu đọc thành tiếng; thiếu thì đọc `message`. */
    speech?: string;
  } | null;
  current_order: {
    id: string;
    waybill_code: string | null;
    scanned_at: string;
    deadline_at: string;
    limit_seconds: number;
    remaining_seconds: number;
    warning: boolean;
  } | null;
}

/** Ngưỡng đọc cảnh báo sắp hết giờ — khớp ORDER_WARNING_LEAD_SECONDS ở server. */
const WARNING_LEAD_SECONDS = 30;

function formatRemaining(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function StationLivePanel({ stationId }: { stationId: string }) {
  const toast = useToast();
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentOrder, setCurrentOrder] = useState<StationEventResponse["current_order"]>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [audioReady, setAudioReady] = useState(false);
  const lastEventId = useRef<string | null>(null);
  const warnedOrderId = useRef<string | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  // Browser audio must be unlocked by a user gesture. We keep the tone local
  // to the viewer; the agent recording/QR pipeline keeps running even when the
  // live panel is closed or remounted.
  const playTone = useCallback((level: AnnouncementLevel) => {
    const context = audioContext.current ?? new window.AudioContext();
    audioContext.current = context;
    if (context.state !== "running") return;
    // Ba mẫu âm khác nhau để nhân viên phân biệt được mà không cần nhìn
    // màn hình: thành công 1 tiếng cao, cảnh báo 2 tiếng, lỗi 3 tiếng trầm.
    const plan =
      level === "success"
        ? { frequency: 880, beeps: 1 }
        : level === "warning"
          ? { frequency: 660, beeps: 2 }
          : { frequency: 420, beeps: 3 };
    for (let index = 0; index < plan.beeps; index += 1) {
      const startAt = context.currentTime + index * 0.22;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(plan.frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.17);
    }
  }, []);

  /**
   * Đọc thành tiếng bằng giọng tiếng Việt của hệ điều hành.
   *
   * `cancel()` trước khi `speak()` để câu mới luôn thắng câu cũ: nhân
   * viên cần nghe trạng thái hiện tại, không cần nghe hết hàng đợi.
   */
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "vi-VN";
    utterance.rate = 1;
    const vietnameseVoice = window.speechSynthesis
      .getVoices()
      .find((voice) => voice.lang?.toLowerCase().startsWith("vi"));
    if (vietnameseVoice) utterance.voice = vietnameseVoice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, []);

  const announce = useCallback(
    (level: AnnouncementLevel, message: string, speech: string) => {
      if (level === "success") toast.success(message);
      else if (level === "warning") toast.info(message);
      else toast.error(message);
      playTone(level);
      speak(speech);
    },
    [playTone, speak, toast],
  );

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
      void context.resume().then(() => setAudioReady(context.state === "running"));
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      const context = audioContext.current;
      audioContext.current = null;
      setAudioReady(false);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
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
        setCurrentOrder(body.current_order ?? null);
        if (!body.event) return;
        if (lastEventId.current === null) {
          // Lần poll đầu chỉ ghi nhận mốc — không đọc lại sự kiện cũ đã
          // xảy ra trước khi người dùng mở màn hình.
          lastEventId.current = body.event.id;
          return;
        }
        if (body.event.id === lastEventId.current) return;
        lastEventId.current = body.event.id;
        announce(body.event.level, body.event.message, body.event.speech ?? body.event.message);
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
  }, [announce, stationId]);

  // Đồng hồ chạy cục bộ giữa hai lượt poll để đếm ngược không giật.
  // Chỉ nhịp `nowMs` là state; số giây còn lại được tính lúc render nên
  // không có setState nào chạy thẳng trong effect.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingSeconds = currentOrder
    ? Math.max(0, Math.ceil((Date.parse(currentOrder.deadline_at) - nowMs) / 1000))
    : null;

  // Cảnh báo sắp hết giờ — đọc đúng một lần cho mỗi đơn.
  useEffect(() => {
    if (!currentOrder || remainingSeconds === null) return;
    if (remainingSeconds > WARNING_LEAD_SECONDS || remainingSeconds <= 0) return;
    if (warnedOrderId.current === currentOrder.id) return;
    warnedOrderId.current = currentOrder.id;
    announce(
      "warning",
      `Sắp hết thời gian đóng đơn · còn ${remainingSeconds}s`,
      "Sắp hết thời gian đóng đơn, còn ba mươi giây",
    );
  }, [announce, currentOrder, remainingSeconds]);

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

  const urgent = remainingSeconds !== null && remainingSeconds <= WARNING_LEAD_SECONDS;

  return (
    <div className="space-y-2">
      <LiveLayout
        stationLabel={`${data.station.code} · ${data.station.name}`}
        overview={data.cameras.overview}
        qr={data.cameras.qr}
      />

      <div className="flex flex-wrap items-center gap-2">
        {currentOrder && remainingSeconds !== null ? (
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold ${
              urgent
                ? "bg-rose-100 text-rose-700"
                : "bg-emerald-100 text-emerald-700"
            }`}
          >
            <Timer className="h-3.5 w-3.5" />
            Đang quay · {currentOrder.waybill_code ?? "đơn đang mở"} · còn{" "}
            {formatRemaining(remainingSeconds)} / {currentOrder.limit_seconds}s
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
            <Timer className="h-3.5 w-3.5" />
            Chưa có đơn đang mở
          </span>
        )}

        <span
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold ${
            audioReady ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-700"
          }`}
        >
          {audioReady ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          {audioReady ? "Đã bật thông báo tiếng" : "Bấm vào màn hình để bật thông báo tiếng"}
        </span>
      </div>

      <p className="text-[11px] text-slate-500">
        Video đi trực tiếp từ bộ phát MediaMTX trên máy bàn; hệ thống cloud không nhận mật khẩu camera.
      </p>
    </div>
  );
}
