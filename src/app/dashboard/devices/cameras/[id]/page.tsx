"use client";

import { useCallback, useEffect, useState, use } from "react";
import { ArrowLeft, Cctv, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DashboardLayout from "@/components/layout/DashboardLayout";
import CodecProbePanel from "@/components/camera/CodecProbePanel";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import {
  CameraDetailPanel,
  CameraDialog,
  type Camera,
  type RecordingInfo,
  type RecordingStatus,
  type LatestFile,
  type RecentFile,
  type ConnCheckEntry,
} from "@/components/devices/CamerasView";

export default function CameraDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const [camera, setCamera] = useState<Camera | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [recInfo, setRecInfo] = useState<RecordingInfo | undefined>(undefined);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [warehouseName, setWarehouseName] = useState<string | null>(null);
  const [connHistory, setConnHistory] = useState<ConnCheckEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [cameras, setCameras] = useState<Camera[]>([]);

  const loadCamera = useCallback(async () => {
    try {
      const res = await fetch("/api/cameras", { cache: "no-store" });
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const j = await res.json();
      const list = (j.cameras ?? []) as Camera[];
      setCameras(list);
      const found = list.find((c) => c.id === id) ?? null;
      setCamera(found);
      setNotFound(!found);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadCamera();
  }, [loadCamera]);

  // Recording status poll — mirrors the cadence the SlideOver used.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [sRes, fRes] = await Promise.all([
          fetch(`/api/cameras/${id}/recording/status`, { cache: "no-store" }),
          fetch(`/api/cameras/${id}/recording/files?limit=5`, {
            cache: "no-store",
          }),
        ]);
        const status = sRes.ok ? ((await sRes.json()) as RecordingStatus) : null;
        const fJson = fRes.ok ? await fRes.json() : { files: [] };
        const files = (fJson.files ?? []) as RecentFile[];
        const latestFile = (files[0] ?? null) as LatestFile | null;
        if (!cancelled) {
          setRecInfo({ status, latestFile });
          setRecentFiles(files);
        }
      } catch {
        if (!cancelled) setRecInfo({ status: null, latestFile: null });
      }
    };
    void refresh();
    const t = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  // Resolve warehouse name from current_station.warehouse_id.
  useEffect(() => {
    if (!camera?.current_station?.warehouse_id) {
      setWarehouseName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/warehouses", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        const list = (j.warehouses ?? j.data ?? []) as Array<{
          id: string;
          name: string;
        }>;
        const w = list.find(
          (x) => x.id === camera.current_station?.warehouse_id,
        );
        if (!cancelled) setWarehouseName(w?.name ?? null);
      } catch {
        if (!cancelled) setWarehouseName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [camera?.current_station?.warehouse_id]);

  // Seed connection-check history from the last stored result so the panel
  // has something to show before the user clicks "Kiểm tra lại".
  useEffect(() => {
    if (!camera) return;
    if (connHistory.length > 0) return;
    if (!camera.last_tested_at || !camera.last_test_result) return;
    const r = camera.last_test_result as {
      success?: boolean;
      message?: string;
      duration_ms?: number;
    };
    setConnHistory([
      {
        at: camera.last_tested_at,
        success: r.success === true,
        duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : null,
        message: r.message ?? null,
      },
    ]);
  }, [camera, connHistory.length]);

  const recordConnCheck = useCallback((entry: ConnCheckEntry) => {
    setConnHistory((prev) => [entry, ...prev].slice(0, 10));
  }, []);

  const onDelete = async () => {
    if (!camera) return;
    const ok = await confirm({
      title: "Xoá camera",
      message: `Camera ${camera.camera_code} sẽ bị xoá khỏi danh sách.`,
      confirmLabel: "Xoá",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/cameras/${camera.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(j.message ?? j.error ?? "Xoá thất bại.");
      return;
    }
    toast.success(`Đã xoá ${camera.camera_code}`);
    router.push("/dashboard/devices?type=camera");
  };

  if (loading) {
    return (
      <DashboardLayout
        pageTitle="Chi tiết camera"
        pageSubtitle="Đang tải..."
        pageIcon={Cctv}
      >
        <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-400 text-sm">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
          Đang tải...
        </div>
      </DashboardLayout>
    );
  }

  if (notFound || !camera) {
    return (
      <DashboardLayout
        pageTitle="Chi tiết camera"
        pageSubtitle="Camera không tồn tại"
        pageIcon={Cctv}
      >
        <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center space-y-3">
          <p className="text-sm text-slate-500">
            Camera <b className="font-mono">{id}</b> không tồn tại hoặc đã bị
            xoá.
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
      pageTitle={camera.name}
      pageSubtitle={`Camera · ${camera.camera_code}`}
      pageIcon={Cctv}
    >
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm h-full min-h-0 flex flex-col overflow-hidden">
        <CameraDetailPanel
          camera={camera}
          recording={recInfo}
          recentFiles={recentFiles}
          warehouseName={warehouseName}
          connHistory={connHistory}
          onRecordConnCheck={recordConnCheck}
          onEdit={() => setEditing(true)}
          onOpenFiles={() => {
            router.push(`/dashboard/devices/cameras/${camera.id}/recordings`);
          }}
          onAfterChange={() => {
            void loadCamera();
          }}
          onBack={() => router.push("/dashboard/devices?type=camera")}
          onDelete={onDelete}
          codecSlot={
            <CodecProbePanel
              cameraId={camera.id}
              initialCodec={camera.codec_detected ?? null}
              initialWarning={camera.codec_warning ?? null}
              initialProbedAt={camera.codec_probed_at ?? null}
              initialError={camera.codec_probe_error ?? null}
            />
          }
        />
      </div>

      {editing && (
        <CameraDialog
          mode="edit"
          initial={camera}
          cameras={cameras}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void loadCamera();
          }}
        />
      )}
    </DashboardLayout>
  );
}
