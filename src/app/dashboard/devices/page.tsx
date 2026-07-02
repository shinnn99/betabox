"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Armchair,
  Cctv,
  ChevronRight,
  Circle,
  Cpu,
  HardDrive,
  Info,
  Link2,
  Loader2,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  ScanLine,
  Search,
  Settings2,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Modal, Field } from "@/components/warehouse-config/Modal";
import {
  CameraDialogBody,
  type Camera,
} from "@/components/devices/CamerasView";
import {
  ScannerPortPicker,
  identityMatches,
  type AgentRow,
  type DeviceIdentity,
} from "@/components/warehouse-config/DevicesTab";

interface DeviceStation {
  station_id: string;
  station_code: string;
  station_name: string;
  warehouse_id?: string;
  is_primary?: boolean;
}

interface CameraDevice extends Camera {
  kind: "camera";
  station_device_id: string | null;
  recording: {
    is_recording: boolean;
    session_status: "recording" | "stopped" | "error" | null;
  } | null;
}

interface ScannerDevice {
  kind: "scanner";
  id: string;
  device_code: string;
  device_type: "scanner";
  name: string;
  status: "active" | "inactive" | "archived";
  connection_type: "serial" | "hid_keyboard" | "manual" | "unknown";
  connection_status: "connected" | "disconnected" | "unknown" | "error";
  current_port: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  bound_agent_id: string | null;
  current_station: DeviceStation | null;
  updated_at: string;
}

type Device = CameraDevice | ScannerDevice;

type TabKey = "all" | "camera" | "scanner" | "unassigned" | "error";

const TAB_LABELS: Record<TabKey, string> = {
  all: "Tất cả",
  camera: "Camera",
  scanner: "Máy quét",
  unassigned: "Chưa gán bàn",
  error: "Có lỗi",
};

// Camera error rule: status='error' OR last_test_result.success=false OR
// recording session in 'error' state. Scanner error rule:
// connection_status='error'. Pre-assignment is NEVER an error.
function isCameraError(c: CameraDevice): boolean {
  if (c.status === "error") return true;
  if (c.last_test_result?.success === false) return true;
  if (c.recording?.session_status === "error") return true;
  return false;
}

function isScannerError(s: ScannerDevice): boolean {
  return s.connection_status === "error";
}

function isDeviceError(d: Device): boolean {
  return d.kind === "camera" ? isCameraError(d) : isScannerError(d);
}

function connectionBadge(d: Device): {
  label: string;
  cls: string;
  icon: typeof Wifi;
} {
  if (d.kind === "camera") {
    if (d.status === "active") {
      return {
        label: "Online",
        cls: "bg-emerald-50 text-emerald-700",
        icon: Wifi,
      };
    }
    if (d.status === "error") {
      return { label: "Offline", cls: "bg-rose-50 text-rose-700", icon: WifiOff };
    }
    return {
      label: "Chưa test",
      cls: "bg-slate-100 text-slate-500",
      icon: WifiOff,
    };
  }
  switch (d.connection_status) {
    case "connected":
      return {
        label: "Đang cắm",
        cls: "bg-emerald-50 text-emerald-700",
        icon: Plug,
      };
    case "error":
      return { label: "Lỗi", cls: "bg-rose-50 text-rose-700", icon: PlugZap };
    case "disconnected":
      return {
        label: "Mất kết nối",
        cls: "bg-amber-50 text-amber-700",
        icon: PlugZap,
      };
    default:
      return {
        label: d.current_port ? "Chưa rõ" : "Chưa ghép",
        cls: "bg-slate-100 text-slate-500",
        icon: Plug,
      };
  }
}

function statusLabel(d: Device): { label: string; cls: string } {
  if (d.kind === "camera") {
    const r = d.recording?.session_status;
    if (d.recording?.is_recording) {
      return { label: "Đang ghi", cls: "text-red-700 bg-red-50" };
    }
    if (r === "error") {
      return { label: "Lỗi ghi", cls: "text-rose-700 bg-rose-50" };
    }
    if (r === "stopped") {
      return { label: "Đã dừng", cls: "text-slate-600 bg-slate-100" };
    }
    return { label: "Sẵn sàng", cls: "text-slate-600 bg-slate-50" };
  }
  if (d.current_port) {
    return { label: "Đã ghép", cls: "text-emerald-700 bg-emerald-50" };
  }
  return { label: "Chưa ghép", cls: "text-slate-500 bg-slate-50" };
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s trước`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  return d.toLocaleString("vi-VN");
}

interface Station {
  id: string;
  code: string;
  name: string;
  warehouse_id: string;
  status: string;
}

export default function DevicesPageWrapper() {
  return (
    <Suspense
      fallback={<div className="p-6 text-sm text-slate-400">Đang tải...</div>}
    >
      <DevicesPage />
    </Suspense>
  );
}

function DevicesPage() {
  const search = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const initialTab = (search.get("type") === "scanner"
    ? "scanner"
    : search.get("type") === "camera"
      ? "camera"
      : "all") as TabKey;

  const [devices, setDevices] = useState<Device[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [q, setQ] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Device | null>(null);
  const [scannerDetailId, setScannerDetailId] = useState<string | null>(null);
  // Per-camera recording action busy (for the inline Ghi/Dừng button).
  const [recBusy, setRecBusy] = useState<Record<string, "start" | "stop">>({});
  const pageActive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [resDevices, resStations] = await Promise.all([
        fetch("/api/devices", { cache: "no-store" }),
        fetch("/api/packing-stations", { cache: "no-store" }),
      ]);
      if (resDevices.ok) {
        const j = await resDevices.json();
        setDevices(j.devices ?? []);
      }
      if (resStations.ok) {
        const j = await resStations.json();
        setStations(
          (j.stations ?? []).filter((s: Station) => s.status === "active"),
        );
      }
    } catch (err) {
      console.error("Load devices failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onVis = () => {
      pageActive.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(() => {
      if (pageActive.current) void load();
    }, 7000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
    };
  }, [load]);

  const counts = useMemo(() => {
    const all = devices.length;
    const camera = devices.filter((d) => d.kind === "camera").length;
    const scanner = devices.filter((d) => d.kind === "scanner").length;
    const unassigned = devices.filter((d) => !d.current_station).length;
    const errored = devices.filter(isDeviceError).length;
    return { all, camera, scanner, unassigned, error: errored };
  }, [devices]);

  const filtered = useMemo(() => {
    let arr = devices;
    if (tab === "camera") arr = arr.filter((d) => d.kind === "camera");
    else if (tab === "scanner") arr = arr.filter((d) => d.kind === "scanner");
    else if (tab === "unassigned") arr = arr.filter((d) => !d.current_station);
    else if (tab === "error") arr = arr.filter(isDeviceError);
    const term = q.trim().toLowerCase();
    if (term) {
      arr = arr.filter((d) => {
        const stationHay =
          (d.current_station?.station_code ?? "") +
          " " +
          (d.current_station?.station_name ?? "");
        if (d.kind === "camera") {
          return (
            d.camera_code.toLowerCase().includes(term) ||
            d.name.toLowerCase().includes(term) ||
            d.ip.includes(term) ||
            (d.location ?? "").toLowerCase().includes(term) ||
            stationHay.toLowerCase().includes(term)
          );
        }
        return (
          d.device_code.toLowerCase().includes(term) ||
          d.name.toLowerCase().includes(term) ||
          (d.current_port ?? "").toLowerCase().includes(term) ||
          stationHay.toLowerCase().includes(term)
        );
      });
    }
    return arr;
  }, [devices, tab, q]);

  const cameraList = useMemo(
    () => devices.filter((d): d is CameraDevice => d.kind === "camera"),
    [devices],
  );

  const toggleRecording = async (cam: CameraDevice, action: "start" | "stop") => {
    setRecBusy((m) => ({ ...m, [cam.id]: action }));
    try {
      const res = await fetch(`/api/cameras/${cam.id}/recording/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.message ?? j.error ?? "Lỗi.");
      } else {
        toast.success(
          action === "start"
            ? `Đã bắt đầu ghi (${cam.camera_code})`
            : `Đã dừng ghi (${cam.camera_code})`,
        );
        void load();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRecBusy((m) => {
        const n = { ...m };
        delete n[cam.id];
        return n;
      });
    }
  };

  const onDeleteScanner = async (s: ScannerDevice) => {
    const ok = await confirm({
      title: "Xoá máy quét",
      message: `Máy quét ${s.device_code} sẽ bị xoá.`,
      confirmLabel: "Xoá",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/station-devices/${s.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.message ?? "Xoá thất bại.");
      return;
    }
    toast.success(`Đã xoá ${s.device_code}`);
    void load();
  };

  return (
    <DashboardLayout
      pageTitle="Thiết bị kho"
      pageSubtitle="Quản lý camera và máy quét trên cùng một nơi"
      pageIcon={Cpu}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1 bg-slate-100/70 p-1 rounded-xl">
            {(["all", "camera", "scanner", "unassigned", "error"] as TabKey[]).map(
              (k) => {
                const active = tab === k;
                const count =
                  k === "all"
                    ? counts.all
                    : k === "camera"
                      ? counts.camera
                      : k === "scanner"
                        ? counts.scanner
                        : k === "unassigned"
                          ? counts.unassigned
                          : counts.error;
                return (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    className={`px-3 h-8 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? "bg-white shadow-sm text-slate-900"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {TAB_LABELS[k]}
                    <span
                      className={`ml-1.5 text-[11px] ${
                        active ? "text-slate-500" : "text-slate-400"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              },
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Tìm thiết bị, IP, bàn..."
                className="h-9 pl-9 pr-3 rounded-xl border border-slate-200 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
              />
            </div>
            <button
              onClick={() => setShowPicker(true)}
              className="h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
            >
              <Plus className="h-4 w-4" /> Thêm thiết bị
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[1240px]">
              <thead className="bg-slate-50/60">
                <tr className="text-left text-[11px] tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-semibold">Thiết bị</th>
                  <th className="px-4 py-3 font-semibold w-24">Loại</th>
                  <th className="px-4 py-3 font-semibold">Bàn đang phục vụ</th>
                  <th className="px-4 py-3 font-semibold w-32">Kết nối</th>
                  <th className="px-4 py-3 font-semibold w-28">Trạng thái</th>
                  <th className="px-4 py-3 font-semibold w-28">Cập nhật</th>
                  <th className="px-4 py-3 font-semibold w-72 text-right whitespace-nowrap">
                    Hành động
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                      Đang tải...
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-400 text-sm">
                      {devices.length === 0
                        ? 'Chưa có thiết bị nào. Nhấn "Thêm thiết bị" để bắt đầu.'
                        : "Không có thiết bị khớp với bộ lọc."}
                    </td>
                  </tr>
                )}
                {filtered.map((d) => {
                  const conn = connectionBadge(d);
                  const ConnIcon = conn.icon;
                  const stt = statusLabel(d);
                  return (
                    <tr
                      key={d.kind === "camera" ? `c_${d.id}` : `s_${d.id}`}
                      className="border-t border-slate-100 align-middle hover:bg-slate-50/40"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {d.kind === "camera" ? (
                            <Cctv className="h-4 w-4 text-slate-400" />
                          ) : (
                            <ScanLine className="h-4 w-4 text-slate-400" />
                          )}
                          <div className="min-w-0">
                            <p className="font-mono font-semibold text-slate-800">
                              {d.kind === "camera"
                                ? d.camera_code
                                : d.device_code}
                            </p>
                            <p className="text-[11px] text-slate-500 truncate">
                              {d.name}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {d.kind === "camera" ? "Camera" : "Máy quét"}
                      </td>
                      <td className="px-4 py-3">
                        {d.current_station ? (
                          <div className="text-xs">
                            <p className="font-mono font-semibold text-slate-800">
                              {d.current_station.station_code}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {d.current_station.station_name}
                              {d.kind === "camera" &&
                                d.current_station.is_primary &&
                                " · chính"}
                            </p>
                          </div>
                        ) : (
                          <button
                            onClick={() => setAssignTarget(d)}
                            className="text-xs text-emerald-600 hover:text-emerald-700 underline underline-offset-2"
                          >
                            Gán bàn
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${conn.cls}`}
                        >
                          <ConnIcon className="h-3 w-3" />
                          {conn.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${stt.cls}`}
                        >
                          {d.kind === "camera" && d.recording?.is_recording && (
                            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                          )}
                          {stt.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {formatRelative(d.updated_at)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1 flex-nowrap">
                          {d.kind === "camera" && (
                            <button
                              onClick={() =>
                                toggleRecording(
                                  d,
                                  d.recording?.is_recording ? "stop" : "start",
                                )
                              }
                              disabled={!!recBusy[d.id] || d.status !== "active"}
                              className={`h-8 px-2.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap ${
                                d.recording?.is_recording
                                  ? "bg-red-500 hover:bg-red-600 text-white"
                                  : "bg-emerald-500 hover:bg-emerald-600 text-white"
                              } disabled:opacity-40 disabled:cursor-not-allowed`}
                              title={
                                d.status !== "active"
                                  ? "Camera chưa Online — Test kết nối trước khi ghi."
                                  : undefined
                              }
                            >
                              {recBusy[d.id] ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Circle
                                  className={`h-3 w-3 ${
                                    d.recording?.is_recording ? "fill-current" : ""
                                  }`}
                                />
                              )}
                              {d.recording?.is_recording ? "Dừng" : "Ghi"}
                            </button>
                          )}
                          <button
                            onClick={() => setAssignTarget(d)}
                            className="h-8 px-2.5 rounded-lg text-xs text-slate-600 hover:bg-slate-100 whitespace-nowrap"
                          >
                            {d.current_station ? "Đổi bàn" : "Gán bàn"}
                          </button>
                          <button
                            onClick={() =>
                              d.kind === "camera"
                                ? router.push(
                                    `/dashboard/devices/cameras/${d.id}`,
                                  )
                                : setScannerDetailId(d.id)
                            }
                            className="h-8 px-2.5 rounded-lg text-xs text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                            Chi tiết
                          </button>
                          {d.kind === "scanner" && (
                            <button
                              onClick={() => onDeleteScanner(d)}
                              className="h-8 px-2.5 rounded-lg text-xs text-rose-600 hover:bg-rose-50 whitespace-nowrap"
                            >
                              Xoá
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Unified "Thêm thiết bị" dialog: dropdown chọn loại, form scanner
          inline, và camera flow (discovery + manual) cũng nằm trong cùng
          một modal. */}
      {showPicker && (
        <AddDeviceModal
          cameras={cameraList}
          onClose={() => setShowPicker(false)}
          onScannerSaved={() => {
            setShowPicker(false);
            void load();
            toast.success("Đã tạo máy quét.");
          }}
          onCameraSaved={() => {
            setShowPicker(false);
            void load();
          }}
        />
      )}

      {assignTarget && (
        <AssignStationDialog
          device={assignTarget}
          stations={stations}
          onClose={() => setAssignTarget(null)}
          onSaved={() => {
            setAssignTarget(null);
            void load();
          }}
        />
      )}

      {scannerDetailId &&
        (() => {
          const s = devices.find(
            (d): d is ScannerDevice =>
              d.kind === "scanner" && d.id === scannerDetailId,
          );
          if (!s) return null;
          return (
            <ScannerDetailDialog
              scanner={s}
              stations={stations}
              onClose={() => setScannerDetailId(null)}
              onChanged={() => void load()}
              onDeleted={() => {
                setScannerDetailId(null);
                void load();
              }}
            />
          );
        })()}
    </DashboardLayout>
  );
}

function AddDeviceModal({
  cameras,
  onClose,
  onScannerSaved,
  onCameraSaved,
}: {
  cameras: CameraDevice[];
  onClose: () => void;
  onScannerSaved: () => void;
  onCameraSaved: () => void;
}) {
  // Unified "Thêm thiết bị" dialog: dropdown picks device type, scanner
  // form stays inline, camera flow (discovery + manual) is embedded via
  // CameraDialogBody so the operator never sees a second modal.
  const [kind, setKind] = useState<"scanner" | "camera">("scanner");
  const [deviceCode, setDeviceCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Live scanner discovery: pull what agents currently see so the operator
  // can pair the USB/COM port in the same step as creating the device,
  // matching the legacy DevicesTab flow.
  const [scannerAgents, setScannerAgents] = useState<AgentRow[] | null>(null);
  const [scannerAgentId, setScannerAgentId] = useState<string>("");
  const [pickedPath, setPickedPath] = useState<string>("");
  const [pickedIdentity, setPickedIdentity] = useState<DeviceIdentity | null>(
    null,
  );

  const loadAgents = useCallback(() => {
    setScannerAgents(null);
    fetch("/api/warehouse/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = (d.agents ?? []) as AgentRow[];
        setScannerAgents(list);
        setScannerAgentId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => setScannerAgents([]));
  }, []);

  useEffect(() => {
    if (kind !== "scanner") return;
    if (scannerAgents !== null) return;
    loadAgents();
  }, [kind, scannerAgents, loadAgents]);

  // Reconcile pickedPath with the live list (in case the agent re-reports
  // and the same identity now appears on a different path).
  useEffect(() => {
    if (!pickedIdentity || !scannerAgents) return;
    const agent = scannerAgents.find((a) => a.id === scannerAgentId);
    const ports = agent?.last_discovered_scanners ?? [];
    const match = ports.find((p) => identityMatches(p.identity, pickedIdentity));
    setPickedPath(match?.path ?? "");
  }, [pickedIdentity, scannerAgents, scannerAgentId]);

  const selectedAgent = scannerAgents?.find((a) => a.id === scannerAgentId);
  const reportedPorts = selectedAgent?.last_discovered_scanners ?? [];

  const submitScanner = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = deviceCode.trim().toUpperCase();
    if (!code || !name.trim()) {
      setErr("Mã và tên là bắt buộc.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        device_code: code,
        device_type: "scanner",
        name: name.trim(),
        connection_type: "serial",
        config_json: {},
        device_identity: pickedIdentity ?? {},
      };
      const res = await fetch("/api/station-devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? "Không tạo được máy quét.");
      }
      onScannerSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Thêm thiết bị" onClose={onClose} size="lg">
      <div className="space-y-3">
        <Field label="Loại thiết bị" required>
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v as "scanner" | "camera");
              setErr(null);
            }}
            options={[
              { value: "scanner", label: "Máy quét mã vạch" },
              { value: "camera", label: "Camera RTSP" },
            ]}
          />
        </Field>

        {kind === "scanner" && (
          <form onSubmit={submitScanner} className="space-y-3">
            <p className="text-xs text-slate-500">
              Khai báo máy quét trước. Sau khi tạo, ghép cổng USB qua agent
              ở phần chi tiết.
            </p>
            <Field
              label="Mã trong kho"
              required
              hint="VD: SCANNER_BAN_01"
            >
              <input
                value={deviceCode}
                onChange={(e) => setDeviceCode(e.target.value)}
                placeholder="SCANNER_BAN_01"
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono uppercase"
                required
              />
            </Field>
            <Field label="Tên" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Máy quét Bàn 01"
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
                required
              />
            </Field>
            <Field
              label="Ghép máy quét đang cắm"
              hint="Bỏ trống nếu thiết bị chưa cắm — có thể ghép sau bằng cách sửa."
            >
              <ScannerPortPicker
                agents={scannerAgents}
                agentId={scannerAgentId}
                onAgentChange={setScannerAgentId}
                onRefresh={loadAgents}
                ports={reportedPorts}
                pickedPath={pickedPath}
                pickedIdentity={pickedIdentity}
                onPick={(path, identity) => {
                  setPickedPath(path);
                  setPickedIdentity(identity);
                }}
                onClear={() => {
                  setPickedPath("");
                  setPickedIdentity(null);
                }}
              />
            </Field>

            {err && <p className="text-sm text-rose-600">{err}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
              >
                Huỷ
              </button>
              <button
                type="submit"
                disabled={saving}
                className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Tạo
              </button>
            </div>
          </form>
        )}

        {kind === "camera" && (
          <div className="pt-1">
            <CameraDialogBody
              mode="create"
              cameras={cameras}
              onClose={onClose}
              onSaved={onCameraSaved}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

function AssignStationDialog({
  device,
  stations,
  onClose,
  onSaved,
}: {
  device: Device;
  stations: Station[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [stationId, setStationId] = useState(
    device.current_station?.station_id ?? "",
  );
  const [primary, setPrimary] = useState(
    device.kind === "camera"
      ? Boolean(device.current_station?.is_primary)
      : false,
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const deviceId =
    device.kind === "camera" ? device.station_device_id : device.id;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stationId) {
      setErr("Vui lòng chọn bàn.");
      return;
    }
    if (!deviceId) {
      setErr("Thiết bị chưa có liên kết nội bộ — vui lòng tải lại trang.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (device.kind === "camera") {
        const desiredRole = primary ? "proof_primary" : "";
        const currentRole = device.current_station?.is_primary
          ? "proof_primary"
          : "";
        if (desiredRole !== currentRole) {
          const res = await fetch(`/api/station-devices/${deviceId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              config_json: {
                camera_id: device.id,
                ...(primary ? { role: "proof_primary" } : {}),
              },
            }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.message ?? "Không cập nhật được vai trò.");
          }
        }
      }
      const res = await fetch("/api/station-device-assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, station_id: stationId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? "Gán bàn thất bại.");
      }
      toast.success("Đã gán bàn.");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const unassign = async () => {
    if (!deviceId || !device.current_station) return;
    setSaving(true);
    try {
      const res = await fetch("/api/station-device-assignments", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? "Bỏ gán thất bại.");
      }
      toast.success("Đã bỏ gán.");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={device.current_station ? "Đổi bàn" : "Gán bàn"}
      onClose={onClose}
      size="md"
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-slate-500">
          Thiết bị:{" "}
          <span className="font-mono font-semibold text-slate-700">
            {device.kind === "camera" ? device.camera_code : device.device_code}
          </span>{" "}
          · {device.name}
        </p>
        <div>
          <label className="text-xs text-slate-600 font-medium">Bàn</label>
          <Select
            value={stationId}
            onChange={setStationId}
            options={stations.map((s) => ({
              value: s.id,
              label: `${s.code} · ${s.name}`,
            }))}
            placeholder="Chọn bàn..."
          />
        </div>
        {device.kind === "camera" && (
          <label
            className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
            title="Hệ thống sẽ ưu tiên camera này để tạo clip bằng chứng cho các đơn được quét tại bàn."
          >
            <input
              type="checkbox"
              checked={primary}
              onChange={(e) => setPrimary(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Camera chính của bàn
          </label>
        )}
        {err && <p className="text-sm text-rose-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          {device.current_station && (
            <button
              type="button"
              onClick={unassign}
              disabled={saving}
              className="h-9 px-3 rounded-xl text-sm text-rose-600 hover:bg-rose-50"
            >
              Bỏ gán
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Lưu
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------
// Scanner detail dialog — info, edit, re-pair, assign in one place. Kept as
// a dialog (no dedicated route) because scanners have few enough fields that
// a single modal beats a full-page detail UX.
// ----------------------------------------------------------------------------

function ScannerDetailDialog({
  scanner,
  stations,
  onClose,
  onChanged,
  onDeleted,
}: {
  scanner: ScannerDevice;
  stations: Station[];
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();

  // Single dirty form: any change is held locally until the user clicks the
  // one footer "Lưu" button, which fans out to the matching endpoints.
  const [name, setName] = useState(scanner.name);
  const [status, setStatus] = useState<ScannerDevice["status"]>(scanner.status);

  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [pickedPath, setPickedPath] = useState<string>("");
  const [pickedIdentity, setPickedIdentity] = useState<DeviceIdentity | null>(
    null,
  );
  // Tracks whether the user touched the picker, so we know to push an
  // unpair (empty identity) instead of leaving the original identity in
  // place. Without this, "Bỏ chọn" then "Lưu" would no-op.
  const [pairDirty, setPairDirty] = useState(false);
  const [showAdvancedPair, setShowAdvancedPair] = useState(false);

  const originalStationId = scanner.current_station?.station_id ?? "";
  const [stationId, setStationId] = useState(originalStationId);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadAgents = useCallback(() => {
    setAgents(null);
    fetch("/api/warehouse/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = (d.agents ?? []) as AgentRow[];
        setAgents(list);
        setAgentId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // If the scanner has a current_port, try to pre-select the matching row
  // once the agents list lands so the picker shows "Đã chọn ✓" by default.
  useEffect(() => {
    if (!agents || !scanner.current_port) return;
    const agent =
      agents.find((a) => a.id === scanner.bound_agent_id) ?? agents[0];
    if (!agent) return;
    setAgentId((cur) => cur || agent.id);
    const ports = agent.last_discovered_scanners ?? [];
    const match = ports.find((p) => p.path === scanner.current_port);
    if (match) {
      setPickedPath(match.path);
      setPickedIdentity(match.identity);
    }
  }, [agents, scanner.current_port, scanner.bound_agent_id]);

  // Reconcile pickedPath against the live list (path can change when the
  // scanner is re-plugged into a different USB port).
  useEffect(() => {
    if (!pickedIdentity || !agents) return;
    const agent = agents.find((a) => a.id === agentId);
    const ports = agent?.last_discovered_scanners ?? [];
    const match = ports.find((p) => identityMatches(p.identity, pickedIdentity));
    setPickedPath(match?.path ?? "");
  }, [pickedIdentity, agents, agentId]);

  const selectedAgent = agents?.find((a) => a.id === agentId);
  const ports = selectedAgent?.last_discovered_scanners ?? [];

  const infoDirty =
    name.trim() !== scanner.name || status !== scanner.status;
  const stationDirty = stationId !== originalStationId;
  const dirty = infoDirty || pairDirty || stationDirty;

  const saveAll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErr("Tên là bắt buộc.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (infoDirty || pairDirty) {
        const body: Record<string, unknown> = {};
        if (infoDirty) {
          body.name = name.trim();
          body.status = status;
        }
        if (pairDirty) {
          body.device_identity = pickedIdentity ?? {};
          if (pickedIdentity) body.connection_type = "serial";
        }
        const res = await fetch(`/api/station-devices/${scanner.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.message ?? "Lưu thất bại.");
        }
      }

      if (stationDirty) {
        // Empty stationId means the user cleared the selection → unassign.
        // Non-empty means assign (server closes any existing mapping).
        if (stationId) {
          const res = await fetch("/api/station-device-assignments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              device_id: scanner.id,
              station_id: stationId,
            }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.message ?? "Gán bàn thất bại.");
          }
        } else if (scanner.current_station) {
          const res = await fetch("/api/station-device-assignments", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ device_id: scanner.id }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.message ?? "Bỏ gán thất bại.");
          }
        }
      }

      toast.success("Đã lưu.");
      onChanged();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: "Xoá máy quét",
      message: `Máy quét ${scanner.device_code} sẽ bị xoá.`,
      confirmLabel: "Xoá",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/station-devices/${scanner.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.message ?? "Xoá thất bại.");
      return;
    }
    toast.success(`Đã xoá ${scanner.device_code}`);
    onDeleted();
  };

  const conn = (() => {
    switch (scanner.connection_status) {
      case "connected":
        return {
          label: "Đang cắm",
          cls: "bg-emerald-50 text-emerald-700",
          Icon: Plug,
        };
      case "error":
        return { label: "Lỗi", cls: "bg-rose-50 text-rose-700", Icon: PlugZap };
      case "disconnected":
        return {
          label: "Mất kết nối",
          cls: "bg-amber-50 text-amber-700",
          Icon: PlugZap,
        };
      default:
        return {
          label: scanner.current_port ? "Chưa rõ" : "Chưa ghép",
          cls: "bg-slate-100 text-slate-500",
          Icon: Plug,
        };
    }
  })();
  const ConnIcon = conn.Icon;

  const boundAgent =
    agents?.find((a) => a.id === scanner.bound_agent_id) ?? null;
  const isPaired = scanner.connection_status === "connected";

  return (
    <Modal
      title={scanner.name}
      headerExtra={
        <span
          className={`inline-flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1 rounded-lg ${conn.cls}`}
        >
          <ConnIcon className="h-3.5 w-3.5" />
          {conn.label}
        </span>
      }
      onClose={onClose}
      size="xl"
    >
      <form onSubmit={saveAll} className="space-y-5">
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-6">
          {/* --- Left column: Thông tin máy ----------------------------- */}
          <div className="space-y-3">
            <h4 className="font-semibold text-slate-800 text-sm inline-flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-emerald-500" />
              Thông tin máy
            </h4>
            <Field label="Tên máy quét" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
                required
              />
            </Field>
            <div className="mb-3">
              <label className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span>Mã trong kho</span>
                <span
                  title="Mã định danh không thể đổi sau khi tạo."
                  className="text-slate-400 cursor-help"
                >
                  <Info className="h-3.5 w-3.5" />
                </span>
              </label>
              <input
                value={scanner.device_code}
                disabled
                className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono uppercase bg-slate-50 text-slate-500"
              />
            </div>
            <Field label="Trạng thái">
              <Select
                value={status}
                onChange={(v) => setStatus(v as ScannerDevice["status"])}
                options={[
                  { value: "active", label: "Hoạt động" },
                  { value: "inactive", label: "Ngừng" },
                  { value: "archived", label: "Lưu trữ" },
                ]}
              />
            </Field>
          </div>

          {/* --- Right column: Bàn phục vụ + Kết nối thiết bị ----------- */}
          <div className="space-y-5">
            <div className="space-y-3">
              <h4 className="font-semibold text-slate-800 text-sm inline-flex items-center gap-2">
                <Armchair className="h-4 w-4 text-emerald-500" />
                Bàn phục vụ
              </h4>
              <Select
                value={stationId}
                onChange={setStationId}
                options={[
                  ...(scanner.current_station
                    ? [{ value: "", label: "— Bỏ gán —" }]
                    : []),
                  ...stations.map((s) => ({
                    value: s.id,
                    label: `${s.code} · ${s.name}`,
                  })),
                ]}
                placeholder="Chọn bàn..."
              />
            </div>

            <div className="space-y-3">
              <h4 className="font-semibold text-slate-800 text-sm inline-flex items-center gap-2">
                <Link2 className="h-4 w-4 text-emerald-500" />
                Kết nối thiết bị
              </h4>
              <div
                className={`rounded-2xl border p-4 space-y-2 ${
                  isPaired
                    ? "border-emerald-200 bg-emerald-50/40"
                    : "border-slate-200 bg-slate-50/60"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                        isPaired ? "bg-emerald-500" : "bg-slate-300"
                      }`}
                    />
                    <span className="font-mono font-semibold text-slate-800 truncate">
                      {scanner.current_port ?? "Chưa ghép"}
                    </span>
                    {isPaired && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                        Đã kết nối
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={loadAgents}
                    className="h-8 px-2.5 rounded-lg border border-slate-200 bg-white text-xs inline-flex items-center gap-1.5 hover:bg-slate-50 shrink-0"
                  >
                    <RefreshCw className="h-3 w-3" /> Làm mới
                  </button>
                </div>
                {(boundAgent || scanner.last_seen_at) && (
                  <div className="space-y-0.5 text-xs text-slate-500">
                    {boundAgent && (
                      <div>
                        Máy tính kho:{" "}
                        <span className="font-mono text-slate-700">
                          {boundAgent.code}
                        </span>
                      </div>
                    )}
                    {scanner.last_seen_at && (
                      <div>
                        Lần thấy cuối:{" "}
                        <span className="text-slate-700">
                          {new Date(scanner.last_seen_at).toLocaleString(
                            "vi-VN",
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {scanner.last_error && (
                  <div className="text-xs text-rose-600 break-words">
                    Lỗi cuối: {scanner.last_error}
                  </div>
                )}
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedPair((v) => !v)}
                    className="text-xs text-emerald-700 hover:text-emerald-800 font-medium inline-flex items-center gap-0.5"
                  >
                    Nâng cao
                    <ChevronRight
                      className={`h-3.5 w-3.5 transition-transform ${
                        showAdvancedPair ? "rotate-90" : ""
                      }`}
                    />
                  </button>
                </div>
                {showAdvancedPair && (
                  <div className="pt-2 border-t border-emerald-100">
                    <ScannerPortPicker
                      agents={agents}
                      agentId={agentId}
                      onAgentChange={setAgentId}
                      onRefresh={loadAgents}
                      ports={ports}
                      pickedPath={pickedPath}
                      pickedIdentity={pickedIdentity}
                      onPick={(path, identity) => {
                        setPickedPath(path);
                        setPickedIdentity(identity);
                        setPairDirty(true);
                      }}
                      onClear={() => {
                        setPickedPath("");
                        setPickedIdentity(null);
                        setPairDirty(true);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {err && <p className="text-sm text-rose-600">{err}</p>}

        {/* --- Footer ----------------------------------------------------- */}
        <div className="border-t border-slate-100 pt-4 flex justify-between items-center">
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="h-9 px-3.5 rounded-xl border border-rose-300 text-rose-600 hover:bg-rose-50 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Xóa máy quét
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
            >
              Đóng
            </button>
            <button
              type="submit"
              disabled={saving || !dirty}
              className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Lưu thay đổi
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
