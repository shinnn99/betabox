"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  PlugZap,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Modal } from "@/components/warehouse-config/Modal";
import { useToast } from "@/components/ui/Toast";
import type { Camera } from "@/components/devices/CamerasView";

interface Result {
  success: boolean;
  message: string;
  at: string;
}

// Test-connection là async: POST enqueue → agent tại kho chạy test → callback
// update cameras.last_tested_at. UI poll /api/cameras cho tới khi last_tested_at
// đổi hoặc timeout ~30s (20 lần × 1.5s).
export function CameraTestConnectionModal({
  camera,
  onClose,
  onAfterChange,
}: {
  camera: Camera;
  onClose: () => void;
  onAfterChange?: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(() => {
    if (!camera.last_tested_at || !camera.last_test_result) return null;
    const r = camera.last_test_result;
    return {
      success: r.success === true,
      message: r.message ?? "",
      at: camera.last_tested_at,
    };
  });
  const cancelled = useRef(false);

  // Chặn Test khi agent offline: enqueue vẫn thành công nhưng agent không
  // xử lý ngay → modal treo 30s vô ích. Bắt agent-off ở FE, hướng dẫn user
  // kiểm tra agent trước.
  const agentOffline = camera.camera_online_state === "warehouse_disconnected";

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  const runTest = async () => {
    setBusy(true);
    try {
      const preTestedAt = camera.last_tested_at ?? null;
      const enqRes = await fetch(`/api/cameras/${camera.id}/test-connection`, {
        method: "POST",
      });
      if (!enqRes.ok) {
        const errJson = await enqRes.json().catch(() => ({}));
        toast.error(
          errJson.message ?? errJson.error ?? "Không gửi được lệnh test tới agent.",
        );
        return;
      }

      const POLL_INTERVAL_MS = 1500;
      const POLL_MAX_ATTEMPTS = 20;
      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelled.current) return;
        const listRes = await fetch("/api/cameras", { cache: "no-store" });
        if (!listRes.ok) continue;
        const listJson = (await listRes.json()) as { cameras?: Camera[] };
        const fresh = listJson.cameras?.find((c) => c.id === camera.id);
        if (!fresh) continue;
        const freshTestedAt = fresh.last_tested_at ?? null;
        if (freshTestedAt && freshTestedAt !== preTestedAt) {
          const r = fresh.last_test_result ?? {};
          const success = r.success === true;
          const message = r.message ?? "";
          setResult({ success, message, at: freshTestedAt });
          if (success) toast.success(message || "Kết nối OK");
          else toast.error(message || "Test thất bại");
          onAfterChange?.();
          return;
        }
      }
      toast.error(
        "Chờ quá lâu chưa có kết quả từ agent. Agent có thể offline hoặc RTSP không tới được camera.",
      );
    } finally {
      if (!cancelled.current) setBusy(false);
    }
  };

  return (
    <Modal title={`Test kết nối · ${camera.camera_code}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-sm text-slate-600">
          Gửi lệnh test tới agent tại kho. Agent sẽ mở RTSP và báo kết quả về (~10-30s).
        </div>

        {agentOffline && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Agent kho đang mất kết nối</p>
              <p className="text-xs mt-0.5">
                Không thể test lúc này. Kiểm tra máy agent tại kho (điện, mạng, app agent chạy chưa), rồi thử lại.
              </p>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={runTest}
          disabled={busy || agentOffline}
          className="w-full h-10 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlugZap className="h-4 w-4" />
          )}
          {busy ? "Đang chờ agent..." : result ? "Test lại" : "Bắt đầu test"}
        </button>

        {result && (
          <div
            className={`rounded-xl border p-3 text-sm ${
              result.success
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {result.success ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {result.success ? "Kết nối OK" : "Thất bại"}
            </div>
            {result.message && (
              <p className="mt-1 text-xs whitespace-pre-wrap">{result.message}</p>
            )}
            <p className="mt-1 text-[11px] text-slate-500">
              {new Date(result.at).toLocaleString("vi-VN")}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
