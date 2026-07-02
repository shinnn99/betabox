"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Circle,
  CircleDashed,
  CircleStop,
  FolderOpen,
  Loader2,
  RotateCw,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface Session {
  id: string;
  status: "recording" | "stopped" | "error";
  transport: "tcp" | "udp";
  segment_seconds: number;
  output_dir: string;
  started_at: string;
  stopped_at: string | null;
  error_message: string | null;
}

type UiState =
  | "recording"
  | "agent_disconnected"
  | "stopped"
  | "error"
  | "unknown";

interface Status {
  ui_state: UiState;
  is_recording: boolean;
  session: Session | null;
  agent_last_seen_at: string | null;
}

interface Props {
  cameraId: string;
  cameraCode: string;
  onOpenFiles: () => void;
}

// Recording row UI: badge + Start/Stop/Restart + "Xem file đã ghi".
// Polls /status every 10s while the page is open.
export default function RecordingControls({
  cameraId,
  cameraCode,
  onOpenFiles,
}: Props) {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const aliveRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/cameras/${cameraId}/recording/status`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as Status;
      if (aliveRef.current) setStatus(data);
    } catch {
      // network blip — leave existing status
    }
  }, [cameraId]);

  useEffect(() => {
    aliveRef.current = true;
    fetchStatus();
    const t = setInterval(fetchStatus, 10_000);
    return () => {
      aliveRef.current = false;
      clearInterval(t);
    };
  }, [fetchStatus]);

  const callAction = async (
    action: "start" | "stop" | "restart",
  ): Promise<void> => {
    setBusy(action);
    try {
      const res = await fetch(
        `/api/cameras/${cameraId}/recording/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) {
        toast.error(data.message ?? data.error ?? `${action} thất bại`);
      } else if (res.status === 409) {
        toast.info("Camera đang được ghi.");
      } else {
        const label =
          action === "start"
            ? "Đã bắt đầu ghi"
            : action === "stop"
              ? "Đã dừng ghi"
              : "Đã khởi động lại ghi";
        toast.success(`${label} (${cameraCode})`);
      }
    } finally {
      setBusy(null);
      fetchStatus();
    }
  };

  const uiState = status?.ui_state ?? "unknown";
  const isRecording = !!status?.is_recording;
  const session = status?.session ?? null;
  const errMsg = session?.error_message;

  return (
    <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 flex flex-wrap items-center gap-3 text-xs">
      <Badge uiState={uiState} />
      {isRecording && (
        <span className="text-slate-600">
          {session?.segment_seconds ?? 60}s/segment ·{" "}
          {session?.transport.toUpperCase()}
        </span>
      )}
      {session?.started_at && (
        <span className="text-slate-500">
          Bắt đầu {new Date(session.started_at).toLocaleTimeString("vi-VN")}
        </span>
      )}
      {uiState === "agent_disconnected" && (
        <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
          Agent kho tạm mất kết nối — camera có thể vẫn đang ghi trên máy kho.
        </span>
      )}
      {uiState === "error" && errMsg && <ErrorBadge message={errMsg} />}

      <div className="ml-auto inline-flex items-center gap-1">
        {!isRecording && (
          <button
            disabled={busy !== null}
            onClick={() => callAction("start")}
            className="h-8 px-2.5 rounded-lg bg-red-500 hover:bg-red-600 text-white inline-flex items-center gap-1 font-semibold disabled:opacity-60"
            title="Bắt đầu ghi liên tục"
          >
            {busy === "start" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Circle className="h-3 w-3 fill-current" />
            )}
            Bắt đầu ghi
          </button>
        )}
        {isRecording && (
          <button
            disabled={busy !== null}
            onClick={() => callAction("stop")}
            className="h-8 px-2.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white inline-flex items-center gap-1 font-semibold disabled:opacity-60"
          >
            {busy === "stop" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CircleStop className="h-3 w-3" />
            )}
            Dừng ghi
          </button>
        )}
        <button
          disabled={busy !== null}
          onClick={() => callAction("restart")}
          className="h-8 px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-1 font-semibold disabled:opacity-60"
          title="Dừng và bắt đầu lại"
        >
          {busy === "restart" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCw className="h-3 w-3" />
          )}
          Khởi động lại
        </button>
        <button
          onClick={onOpenFiles}
          className="h-8 px-2.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 inline-flex items-center gap-1 font-semibold"
        >
          <FolderOpen className="h-3 w-3" /> File đã ghi
        </button>
      </div>
    </div>
  );
}

function ErrorBadge({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  // Show the most informative line: ffmpeg's own error is usually the
  // SECOND line ("Error opening input: ..."), not the first ("ffmpeg
  // exited code=..."). Pick whichever non-trivial line we find.
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  const headline =
    lines.find((l) => !/^ffmpeg (exited|killed)/i.test(l)) ??
    lines[0] ??
    "Lỗi không rõ";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-rose-700 bg-rose-50 hover:bg-rose-100 px-2 py-0.5 rounded max-w-md truncate inline-flex items-center gap-1"
        title="Bấm để xem chi tiết"
      >
        <span className="truncate">{headline}</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[70vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800 text-sm">
              Chi tiết lỗi recording
            </div>
            <pre className="px-4 py-3 text-[11px] font-mono text-rose-700 whitespace-pre-wrap break-all">
              {message}
            </pre>
            <div className="px-4 py-2 border-t border-slate-100 text-right">
              <button
                onClick={() => setOpen(false)}
                className="h-8 px-3 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-semibold"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Badge({ uiState }: { uiState: UiState }) {
  if (uiState === "recording") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 text-red-700 font-semibold">
        <Circle className="h-2.5 w-2.5 fill-current animate-pulse" />
        Đang ghi
      </span>
    );
  }
  if (uiState === "agent_disconnected") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold">
        Agent mất kết nối
      </span>
    );
  }
  if (uiState === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-semibold">
        Lỗi ghi
      </span>
    );
  }
  if (uiState === "stopped") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">
        <CircleDashed className="h-2.5 w-2.5" />
        Đã dừng
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">
      <CircleDashed className="h-2.5 w-2.5" />
      Chưa ghi
    </span>
  );
}
