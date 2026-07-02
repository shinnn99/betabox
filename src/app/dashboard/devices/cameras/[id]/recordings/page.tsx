"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import DateRangePicker from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";

interface RecordingFile {
  id: string;
  file_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  status: "ready" | "missing" | "corrupted";
}

interface CameraLite {
  id: string;
  name: string;
  camera_code: string;
}

const PAGE_SIZE = 50;

function formatSize(bytes: number | null): string {
  if (!bytes) return "—";
  const kb = bytes / 1024;
  const mb = kb / 1024;
  const gb = mb / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  if (mb >= 0.1) return `${mb.toFixed(2)} MB`;
  return `${kb.toFixed(1)} KB`;
}

function formatDuration(sec: number | null): string {
  if (!sec) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

// "2026-06-28" -> Date at local 00:00. End of day uses 23:59:59.999.
function dayStart(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function dayEnd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

export default function CameraRecordingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: cameraId } = use(params);
  const toast = useToast();

  const [camera, setCamera] = useState<CameraLite | null>(null);
  const [cameraNotFound, setCameraNotFound] = useState(false);

  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const [files, setFiles] = useState<RecordingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [playing, setPlaying] = useState<RecordingFile | null>(null);

  // Resolve camera meta from the list endpoint. Cheap relative to the
  // recordings list and avoids adding a single-camera GET route.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/cameras", { cache: "no-store" });
      if (!res.ok) {
        if (!cancelled) setCameraNotFound(true);
        return;
      }
      const data = (await res.json()) as {
        cameras?: Array<{ id: string; name: string; camera_code: string }>;
      };
      const cam = (data.cameras ?? []).find((c) => c.id === cameraId) ?? null;
      if (cancelled) return;
      if (!cam) {
        setCameraNotFound(true);
      } else {
        setCamera({ id: cam.id, name: cam.name, camera_code: cam.camera_code });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  const buildQuery = useCallback(
    (limit: number, before?: string) => {
      const sp = new URLSearchParams();
      sp.set("limit", String(limit));
      if (from) sp.set("from", dayStart(from).toISOString());
      if (to) sp.set("to", dayEnd(to).toISOString());
      if (before) sp.set("before", before);
      return sp.toString();
    },
    [from, to],
  );

  const fetchPage = useCallback(
    async (before?: string): Promise<RecordingFile[]> => {
      // Ask for one extra so we know if there is more without an exact count.
      const limit = PAGE_SIZE + 1;
      const qs = buildQuery(limit, before);
      const res = await fetch(
        `/api/cameras/${cameraId}/recording/files?${qs}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message ?? data.error ?? "Không tải được danh sách");
        return [];
      }
      return (data.files ?? []) as RecordingFile[];
    },
    [cameraId, buildQuery, toast],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const page = await fetchPage();
    const truncated = page.length > PAGE_SIZE;
    setFiles(truncated ? page.slice(0, PAGE_SIZE) : page);
    setHasMore(truncated);
    setLoading(false);
  }, [fetchPage]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    if (loadingMore || files.length === 0) return;
    setLoadingMore(true);
    const last = files[files.length - 1];
    const page = await fetchPage(last.started_at);
    const truncated = page.length > PAGE_SIZE;
    setFiles((prev) => [...prev, ...(truncated ? page.slice(0, PAGE_SIZE) : page)]);
    setHasMore(truncated);
    setLoadingMore(false);
  };

  const onSync = async () => {
    setSyncing(true);
    const res = await fetch(
      `/api/cameras/${cameraId}/recording/sync-files`,
      { method: "POST" },
    );
    const data = await res.json();
    setSyncing(false);
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Đồng bộ thất bại");
      return;
    }
    toast.success(
      `Quét ${data.scanned ?? 0} file · thêm ${data.inserted ?? 0} · ` +
        `cập nhật ${data.updated ?? 0} · xoá ${data.deleted ?? 0}`,
    );
    load();
  };

  const subtitle = useMemo(() => {
    if (!camera) return "Đang tải...";
    return `${camera.name} · ${camera.camera_code}`;
  }, [camera]);

  const totalBytes = useMemo(
    () => files.reduce((acc, f) => acc + (f.file_size_bytes ?? 0), 0),
    [files],
  );

  if (cameraNotFound) {
    return (
      <DashboardLayout
        pageTitle="Không tìm thấy camera"
        pageSubtitle="Camera không tồn tại hoặc đã bị xoá"
        pageIcon={FolderOpen}
      >
        <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center">
          <p className="text-slate-500 text-sm mb-4">
            Camera <b className="font-mono">{cameraId}</b> không tồn tại.
          </p>
          <Link
            href="/dashboard/devices?type=camera"
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold"
          >
            <ArrowLeft className="h-4 w-4" /> Về danh sách thiết bị
          </Link>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout
      pageTitle="Video đã ghi"
      pageSubtitle={subtitle}
      pageIcon={FolderOpen}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/dashboard/devices/cameras/${cameraId}`}
            className="h-9 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-2 text-sm text-slate-700"
          >
            <ArrowLeft className="h-4 w-4" /> Quay lại chi tiết
          </Link>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <DateRangePicker
              from={from}
              to={to}
              onChange={({ from: f, to: t }) => {
                setFrom(f);
                setTo(t);
              }}
              placeholder="Tất cả các ngày"
            />
            <button
              onClick={onSync}
              disabled={syncing}
              className="h-9 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center gap-2 text-xs font-semibold disabled:opacity-60"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Đồng bộ thư mục
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {loading
                ? "Đang tải..."
                : `${files.length} file${hasMore ? "+" : ""} · sắp xếp theo thời gian giảm dần`}
            </p>
            {!loading && files.length > 0 && (
              <p className="text-xs text-slate-500">
                Tổng dung lượng:{" "}
                <span className="font-semibold text-slate-700">
                  {formatSize(totalBytes)}
                </span>
                {hasMore && (
                  <span className="text-slate-400">
                    {" "}
                    (trong {files.length} file đã tải)
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-[11px] tracking-wider text-slate-500">
                  <th className="px-4 py-2 font-semibold whitespace-nowrap">Tên file</th>
                  <th className="px-4 py-2 font-semibold whitespace-nowrap">Bắt đầu</th>
                  <th className="px-4 py-2 font-semibold whitespace-nowrap">Thời lượng</th>
                  <th className="px-4 py-2 font-semibold whitespace-nowrap">Dung lượng</th>
                  <th className="px-4 py-2 font-semibold whitespace-nowrap text-right">
                    Hành động
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-slate-400"
                    >
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                      Đang tải...
                    </td>
                  </tr>
                )}
                {!loading && files.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-slate-400 text-sm"
                    >
                      Không có file ghi nào trong khoảng đã chọn.
                    </td>
                  </tr>
                )}
                {files.map((f) => (
                  <tr
                    key={f.id}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-4 py-2 font-mono text-xs text-slate-700 whitespace-nowrap">
                      {f.file_name}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 whitespace-nowrap">
                      {new Date(f.started_at).toLocaleString("vi-VN")}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 whitespace-nowrap">
                      {formatDuration(f.duration_seconds)}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 whitespace-nowrap">
                      {formatSize(f.file_size_bytes)}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => setPlaying(f)}
                        className="h-7 px-2.5 rounded bg-violet-50 hover:bg-violet-100 text-violet-700 text-xs font-semibold"
                      >
                        Xem
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && !loading && (
            <div className="px-4 py-3 border-t border-slate-100 text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="h-9 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60"
              >
                {loadingMore && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Tải thêm
              </button>
            </div>
          )}
        </div>
      </div>

      {playing && (
        <PlayerModal file={playing} onClose={() => setPlaying(null)} />
      )}
    </DashboardLayout>
  );
}

function PlayerModal({
  file,
  onClose,
}: {
  file: RecordingFile;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-black rounded-2xl shadow-xl w-full max-w-3xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-2 right-2 z-10 h-8 w-8 rounded-lg bg-black/60 hover:bg-black text-white inline-flex items-center justify-center"
        >
          <X className="h-4 w-4" />
        </button>
        <video
          src={`/api/recordings/${file.id}`}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="w-full rounded-2xl aspect-video bg-black"
        />
        <p className="px-4 py-2 text-[11px] text-white/60 font-mono">
          {file.file_name}
        </p>
      </div>
    </div>
  );
}
