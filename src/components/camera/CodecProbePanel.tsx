"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";

/**
 * 1.2: panel probe codec manual cho camera detail page.
 *
 * Mục đích: cho user chủ động probe onboard-time — trước khi start
 * recording, để không rơi vào ca "ghi HEVC cả ngày rồi mới cảnh báo".
 *
 * Flow: user bấm "Probe" → POST /api/cameras/[id]/probe-codec → agent
 * xử async → panel poll /api/cameras để lấy codec_detected mới nhất.
 */
interface CodecProbePanelProps {
  cameraId: string;
  initialCodec: string | null;
  initialWarning: string | null;
  initialProbedAt: string | null;
  initialError: string | null;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15; // ~30s total

function badgeFor(codec: string | null): {
  bg: string;
  text: string;
  Icon: typeof AlertTriangle;
  label: string;
} {
  if (!codec) {
    return {
      bg: "bg-slate-100 border-slate-200",
      text: "text-slate-600",
      Icon: RefreshCw,
      label: "Chưa probe",
    };
  }
  if (codec === "h264") {
    return {
      bg: "bg-emerald-50 border-emerald-200",
      text: "text-emerald-700",
      Icon: CheckCircle2,
      label: "H.264 (browser xem được)",
    };
  }
  return {
    bg: "bg-red-50 border-red-200",
    text: "text-red-700",
    Icon: AlertTriangle,
    label: `${codec.toUpperCase()} (browser KHÔNG xem được)`,
  };
}

export default function CodecProbePanel({
  cameraId,
  initialCodec,
  initialWarning,
  initialProbedAt,
  initialError,
}: CodecProbePanelProps) {
  const [codec, setCodec] = useState<string | null>(initialCodec);
  const [warning, setWarning] = useState<string | null>(initialWarning);
  const [probedAt, setProbedAt] = useState<string | null>(initialProbedAt);
  const [probeError, setProbeError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshCamera = useCallback(async (): Promise<{
    codec: string | null;
    warning: string | null;
    probedAt: string | null;
    error: string | null;
  } | null> => {
    try {
      const res = await fetch("/api/cameras", { cache: "no-store" });
      if (!res.ok) return null;
      const j = (await res.json()) as {
        cameras?: Array<{
          id: string;
          codec_detected?: string | null;
          codec_warning?: string | null;
          codec_probed_at?: string | null;
          codec_probe_error?: string | null;
        }>;
      };
      const cam = j.cameras?.find((c) => c.id === cameraId);
      if (!cam) return null;
      return {
        codec: cam.codec_detected ?? null,
        warning: cam.codec_warning ?? null,
        probedAt: cam.codec_probed_at ?? null,
        error: cam.codec_probe_error ?? null,
      };
    } catch {
      return null;
    }
  }, [cameraId]);

  const runProbe = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/cameras/${cameraId}/probe-codec`, {
        method: "POST",
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setMsg(
          `Không enqueue được probe: ${errJson.error ?? res.status} — ${errJson.message ?? ""}`,
        );
        setBusy(false);
        return;
      }
      setMsg("Đã gửi lệnh probe tới agent, đang chờ kết quả...");

      // Poll để bắt kết quả — dừng khi codec_probed_at đổi so với initialProbedAt
      const startProbedAt = probedAt;
      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const fresh = await refreshCamera();
        if (fresh && fresh.probedAt !== startProbedAt) {
          setCodec(fresh.codec);
          setWarning(fresh.warning);
          setProbedAt(fresh.probedAt);
          setProbeError(fresh.error);
          if (fresh.error) {
            setMsg(`Probe fail: ${fresh.error}`);
          } else if (fresh.codec === "h264") {
            setMsg(`Probe xong: H.264 ✓`);
          } else {
            setMsg(`Probe xong: ${fresh.codec?.toUpperCase() ?? "?"} — cần chỉnh camera sang H.264.`);
          }
          setBusy(false);
          return;
        }
      }
      setMsg(
        "Chờ quá lâu chưa có kết quả. Agent có thể offline hoặc RTSP không tới được camera. Kiểm tra agent + camera rồi thử lại.",
      );
      setBusy(false);
    } catch (err) {
      setMsg(`Lỗi: ${(err as Error).message}`);
      setBusy(false);
    }
  }, [cameraId, probedAt, refreshCamera]);

  // Auto-refresh lần đầu để lấy state mới nhất (trường hợp cache client cũ)
  useEffect(() => {
    void refreshCamera().then((fresh) => {
      if (fresh) {
        setCodec(fresh.codec);
        setWarning(fresh.warning);
        setProbedAt(fresh.probedAt);
        setProbeError(fresh.error);
      }
    });
  }, [refreshCamera]);

  const badge = badgeFor(codec);
  const BadgeIcon = badge.Icon;

  return (
    <div className={`rounded-lg border ${badge.bg} px-4 py-3`}>
      <div className="flex items-start gap-3">
        <BadgeIcon
          className={`mt-0.5 h-5 w-5 flex-none ${badge.text} ${busy ? "animate-spin" : ""}`}
        />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-semibold ${badge.text}`}>Codec: {badge.label}</div>
          {warning && (
            <div className="mt-0.5 text-xs text-red-700">
              Cảnh báo: <span className="font-mono">{warning}</span>
            </div>
          )}
          {probeError && (
            <div className="mt-0.5 text-xs text-red-700">
              Lỗi probe cuối: <span className="font-mono">{probeError}</span>
            </div>
          )}
          {probedAt && (
            <div className="mt-0.5 text-xs text-slate-500">
              Probe cuối:{" "}
              {new Date(probedAt).toLocaleString("vi-VN", {
                dateStyle: "short",
                timeStyle: "medium",
              })}
            </div>
          )}
          {msg && (
            <div className="mt-2 text-xs italic text-slate-600">{msg}</div>
          )}
          <div className="mt-2">
            <button
              type="button"
              onClick={runProbe}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {busy ? "Đang probe..." : "Probe codec ngay"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
