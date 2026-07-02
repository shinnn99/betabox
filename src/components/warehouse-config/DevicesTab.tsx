"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  CircleDot,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Unlink,
} from "lucide-react";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import { Modal, Field } from "./Modal";

type DeviceType = "scanner" | "camera" | "printer" | "scale";

const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  scanner: "Máy quét",
  camera: "Camera",
  printer: "Máy in",
  scale: "Cân",
};

export interface DeviceIdentity {
  vid?: string;
  pid?: string;
  serial_number?: string;
  pnp_id?: string;
  manufacturer?: string;
  product?: string;
  friendly_name?: string;
}

interface Device {
  id: string;
  device_code: string;
  device_type: DeviceType;
  name: string;
  config_json: Record<string, unknown>;
  status: string;
  current_station: {
    station_id: string;
    station_code: string;
    station_name: string;
    warehouse_id: string;
    assigned_at: string;
  } | null;
  // Scanner-only runtime fields. Optional because cameras/scales don't use them.
  connection_type?: "serial" | "hid_keyboard" | "manual" | "unknown";
  device_identity?: DeviceIdentity | null;
  current_port?: string | null;
  connection_status?: "connected" | "disconnected" | "unknown" | "error";
  last_seen_at?: string | null;
  last_error?: string | null;
}

interface Station {
  id: string;
  code: string;
  name: string;
  warehouse_id: string;
  status: string;
}

/**
 * Devices are org-scoped (not warehouse-scoped) but the UI on a warehouse
 * page focuses on devices currently assigned to a station inside this
 * warehouse. We also surface unassigned org-level devices so a manager
 * can attach them.
 */
export default function DevicesTab({ warehouseId }: { warehouseId: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [devices, setDevices] = useState<Device[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [assigning, setAssigning] = useState<Device | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [r1, r2] = await Promise.all([
      fetch("/api/station-devices", { cache: "no-store" }),
      fetch(`/api/packing-stations?warehouse_id=${warehouseId}`, {
        cache: "no-store",
      }),
    ]);
    const d1 = await r1.json();
    const d2 = await r2.json();
    if (r1.ok) setDevices(d1.devices ?? []);
    if (r2.ok) setStations(d2.stations ?? []);
    setLoading(false);
  }, [warehouseId]);

  useEffect(() => {
    load();
  }, [load]);

  const onArchive = async (dev: Device) => {
    const ok = await confirm({
      title: "Lưu trữ thiết bị?",
      message: (
        <>
          Thiết bị <b>{dev.name}</b> ({dev.device_code}) sẽ chuyển sang lưu trữ.
          Mapping hiện tại (nếu có) sẽ được đóng lại.
        </>
      ),
      confirmLabel: "Lưu trữ",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/station-devices/${dev.id}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Lưu trữ thất bại");
      return;
    }
    toast.success(`Đã lưu trữ ${dev.device_code}`);
    load();
  };

  const onUnassign = async (dev: Device) => {
    const ok = await confirm({
      title: "Gỡ thiết bị khỏi bàn?",
      message: (
        <>
          Thiết bị <b>{dev.device_code}</b> sẽ ngừng gán vào{" "}
          <b>{dev.current_station?.station_code}</b>. Lịch sử mapping vẫn được giữ lại.
        </>
      ),
      confirmLabel: "Gỡ",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch("/api/station-device-assignments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: dev.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Gỡ thất bại");
      return;
    }
    toast.success("Đã gỡ thiết bị");
    load();
  };

  // Devices either assigned to a station in this warehouse OR unassigned
  // (so the manager can attach them).
  const visibleDevices = devices.filter(
    (d) =>
      d.status === "active" &&
      (d.current_station?.warehouse_id === warehouseId ||
        d.current_station === null),
  );
  const archivedDevices = devices.filter((d) => d.status !== "active");

  const assignedCount = visibleDevices.filter((d) => !!d.current_station).length;
  const unassignedCount = visibleDevices.length - assignedCount;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Mỗi bàn cần 1 máy quét và 1 camera. Camera khai báo ở{" "}
        <a
          href="/dashboard/devices?type=camera"
          className="underline font-medium hover:text-slate-700"
        >
          trang Camera
        </a>
        , tại đây gán nó vào bàn.
      </p>
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          {visibleDevices.length} thiết bị · {assignedCount} đã gán bàn ·{" "}
          {unassignedCount} chưa gán
          {archivedDevices.length > 0 &&
            ` · ${archivedDevices.length} đã lưu trữ`}
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
        >
          <Plus className="h-4 w-4" /> Thêm thiết bị
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/60">
            <tr className="text-left text-[11px] tracking-wider text-slate-500">
              <th className="px-4 py-2.5 font-semibold">Mã trong kho</th>
              <th className="px-4 py-2.5 font-semibold w-28">Loại</th>
              <th className="px-4 py-2.5 font-semibold">Tên</th>
              <th className="px-4 py-2.5 font-semibold">Gán vào bàn</th>
              <th className="px-4 py-2.5 font-semibold text-right whitespace-nowrap w-56">
                <span className="inline-block w-44 text-center">Hành động</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Đang tải...
                </td>
              </tr>
            )}
            {!loading && visibleDevices.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400 text-sm">
                  Chưa có thiết bị nào.
                </td>
              </tr>
            )}
            {visibleDevices.map((d) => (
              <tr
                key={d.id}
                className="border-t border-slate-100 hover:bg-slate-50/60"
              >
                <td className="px-4 py-2.5 font-mono font-semibold text-slate-800">
                  <div>{d.device_code}</div>
                  {d.device_type === "scanner" && (
                    <ScannerRuntimeBadge device={d} />
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold">
                    {DEVICE_TYPE_LABEL[d.device_type]}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-800">{d.name}</td>
                <td className="px-4 py-2.5">
                  {d.current_station ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-semibold bg-emerald-50 px-2 py-0.5 rounded">
                      <LinkIcon className="h-3 w-3" />
                      {d.current_station.station_code}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Chưa gán</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <div className="inline-flex items-center justify-center gap-1 w-44">
                    <button
                      onClick={() => setAssigning(d)}
                      className="h-8 px-2.5 rounded-lg text-emerald-700 bg-emerald-50 hover:bg-emerald-100 inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap"
                    >
                      <LinkIcon className="h-3 w-3" />
                      {d.current_station ? "Đổi bàn" : "Gán bàn"}
                    </button>
                    {d.current_station && (
                      <button
                        onClick={() => onUnassign(d)}
                        className="h-8 w-8 rounded-lg hover:bg-amber-50 inline-flex items-center justify-center text-amber-600"
                        title="Gỡ khỏi bàn"
                      >
                        <Unlink className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => setEditing(d)}
                      className="h-8 w-8 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-600"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onArchive(d)}
                      className="h-8 w-8 rounded-lg hover:bg-red-50 inline-flex items-center justify-center text-red-600"
                      title="Lưu trữ"
                    >
                      <Archive className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <DeviceDialog
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editing && (
        <DeviceDialog
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {assigning && (
        <AssignDialog
          device={assigning}
          stations={stations.filter((s) => s.status === "active")}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ScannerRuntimeBadge({ device }: { device: Device }) {
  const status = device.connection_status ?? "unknown";
  const styles: Record<string, string> = {
    connected: "bg-emerald-50 text-emerald-700",
    disconnected: "bg-slate-100 text-slate-500",
    error: "bg-red-50 text-red-700",
    unknown: "bg-slate-50 text-slate-400",
  };
  const labels: Record<string, string> = {
    connected: "Đang kết nối",
    disconnected: "Mất kết nối",
    error: "Lỗi",
    unknown: "Chưa rõ",
  };
  const identitySummary = (() => {
    const id = device.device_identity;
    if (!id) return null;
    if (id.serial_number) return `SN ${id.serial_number}`;
    if (id.vid && id.pid) return `${id.vid}:${id.pid}`;
    if (id.pnp_id) return id.pnp_id.slice(0, 28) + (id.pnp_id.length > 28 ? "…" : "");
    return null;
  })();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-normal">
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold ${styles[status]}`}
      >
        <CircleDot className="h-2.5 w-2.5" />
        {labels[status]}
      </span>
      {device.current_port && (
        <span className="text-slate-500 font-mono">{device.current_port}</span>
      )}
      {identitySummary && (
        <span className="text-slate-400 font-mono">{identitySummary}</span>
      )}
    </div>
  );
}

/**
 * Two USB identities point at the same physical device when serial or
 * pnp_id matches, OR when VID+PID match and the discovery list contained
 * no stronger discriminator. Used to highlight the currently-paired port
 * in the edit form.
 */
export function identityMatches(a: DeviceIdentity, b: DeviceIdentity): boolean {
  if (a.serial_number && b.serial_number)
    return a.serial_number === b.serial_number;
  if (a.pnp_id && b.pnp_id) return a.pnp_id === b.pnp_id;
  if (a.vid && a.pid && b.vid && b.pid)
    return a.vid === b.vid && a.pid === b.pid;
  return false;
}

interface CameraOption {
  id: string;
  camera_code: string;
  name: string;
  location: string | null;
  status: string;
}

function DeviceDialog({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Device;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialCfg = (initial?.config_json ?? {}) as Record<string, unknown>;
  const [form, setForm] = useState({
    device_code: initial?.device_code ?? "",
    device_type: initial?.device_type ?? ("scanner" as DeviceType),
    name: initial?.name ?? "",
    // Camera-specific structured fields.
    camera_id: String(initialCfg.camera_id ?? ""),
    camera_role_primary: String(initialCfg.role ?? "") === "proof_primary",
    // Non-camera fallback: raw JSON editor.
    config_json_text: JSON.stringify(initial?.config_json ?? {}, null, 2),
    status: initial?.status ?? "active",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Lazy-loaded list of cameras owned by the org. Only fetched when
  // the user actually picks device_type=camera so we don't query for
  // scanner/printer/scale forms.
  const [cameras, setCameras] = useState<CameraOption[] | null>(null);
  const [camerasLoading, setCamerasLoading] = useState(false);

  // Live scanner discovery: when the user opens the form for a scanner,
  // pull what agents currently see so they can pair in one step instead
  // of "create now, pair later". Only populated for scanner type and
  // only during create mode — edit-mode uses the row-level Pair button.
  const [scannerAgents, setScannerAgents] = useState<AgentRow[] | null>(null);
  const [scannerAgentId, setScannerAgentId] = useState<string>("");
  // pickedPath: matches a row in the live discovery list. Empty when the
  // user hasn't selected one this session, OR when editing and the saved
  // identity doesn't currently match any visible port (scanner unplugged).
  const [pickedPath, setPickedPath] = useState<string>("");
  // pickedIdentity: the identity to submit. Initialised from initial.device_identity
  // in edit mode so the form remembers an existing pairing even if the scanner
  // is currently unplugged.
  const initialIdentity = (initial?.device_identity ?? null) as DeviceIdentity | null;
  const [pickedIdentity, setPickedIdentity] = useState<DeviceIdentity | null>(
    initialIdentity && Object.keys(initialIdentity).length > 0
      ? initialIdentity
      : null,
  );

  useEffect(() => {
    if (form.device_type !== "scanner") return;
    if (scannerAgents !== null) return;
    fetch("/api/warehouse/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = (d.agents ?? []) as AgentRow[];
        setScannerAgents(list);
        if (list.length > 0) setScannerAgentId(list[0].id);
      })
      .catch(() => setScannerAgents([]));
  }, [form.device_type, scannerAgents]);

  // When the discovery list refreshes, derive pickedPath: if the currently
  // saved identity (vid/pid/serial) matches one of the visible ports, mark
  // that row "Đã chọn ✓" so the operator can see "this is where it's
  // bound" without re-picking.
  useEffect(() => {
    if (!pickedIdentity || !scannerAgents) return;
    const agent = scannerAgents.find((a) => a.id === scannerAgentId);
    const ports = agent?.last_discovered_scanners ?? [];
    const match = ports.find((p) => identityMatches(p.identity, pickedIdentity));
    setPickedPath(match?.path ?? "");
  }, [pickedIdentity, scannerAgents, scannerAgentId]);

  const refreshAgents = () => {
    setScannerAgents(null);
  };

  const selectedAgent = scannerAgents?.find((a) => a.id === scannerAgentId);
  const reportedPorts = selectedAgent?.last_discovered_scanners ?? [];

  useEffect(() => {
    if (form.device_type !== "camera") return;
    if (cameras !== null) return;
    setCamerasLoading(true);
    fetch("/api/cameras", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setCameras((d.cameras ?? []) as CameraOption[]);
        // Auto-pick if there's exactly one camera and we're creating.
        if (
          mode === "create" &&
          Array.isArray(d.cameras) &&
          d.cameras.length === 1 &&
          !form.camera_id
        ) {
          setForm((f) => ({ ...f, camera_id: d.cameras[0].id }));
        }
      })
      .catch(() => setCameras([]))
      .finally(() => setCamerasLoading(false));
  }, [form.device_type, cameras, mode, form.camera_id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");

    let config: Record<string, unknown> = {};
    if (form.device_type === "camera") {
      // Build config from structured fields. Backend will reject if
      // camera_id is empty / unknown / already claimed.
      if (!form.camera_id) {
        setErr("Vui lòng chọn camera.");
        return;
      }
      config = {
        camera_id: form.camera_id,
        ...(form.camera_role_primary ? { role: "proof_primary" } : {}),
      };
    } else if (form.device_type === "scanner") {
      // Scanner config_json intentionally stays empty. Identity (VID/PID/
      // serial) and current_port live in their own columns, populated by
      // the Pair-dialog and discovery loop — never by this form.
      config = (initial?.config_json as Record<string, unknown>) ?? {};
    } else if (form.config_json_text.trim()) {
      try {
        config = JSON.parse(form.config_json_text);
      } catch {
        setErr("Config JSON không hợp lệ.");
        return;
      }
    }

    setSaving(true);
    const url =
      mode === "create"
        ? "/api/station-devices"
        : `/api/station-devices/${initial!.id}`;
    const method = mode === "create" ? "POST" : "PATCH";
    const body: Record<string, unknown> = {
      device_code: form.device_code,
      device_type: form.device_type,
      name: form.name,
      config_json: config,
    };
    if (mode === "edit") body.status = form.status;

    // Pair-in-one-step: send the current identity selection along with
    // create OR edit. In edit mode pickedIdentity is seeded from the
    // existing device_identity so a no-op save keeps the pairing. Clearing
    // sends `{}` to explicitly unpair.
    if (form.device_type === "scanner") {
      body.device_identity = pickedIdentity ?? {};
      if (pickedIdentity) body.connection_type = "serial";
    }
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Lưu thất bại");
      return;
    }
    onSaved();
  };

  // For camera dropdown, include the currently-bound camera even if
  // some other device claimed it concurrently — so we can still
  // display the row label. The backend will block save in that case
  // with a clear error.
  const cameraOptions = (cameras ?? []).map((c) => ({
    value: c.id,
    label: `${c.camera_code} — ${c.name}`,
    hint: c.location ?? undefined,
  }));
  if (
    form.camera_id &&
    cameras !== null &&
    !cameras.find((c) => c.id === form.camera_id)
  ) {
    cameraOptions.unshift({
      value: form.camera_id,
      label: "(Camera không còn trong danh sách)",
      hint: undefined,
    });
  }

  return (
    <Modal
      title={mode === "create" ? "Gán thiết bị vào bàn" : `Sửa: ${initial?.name}`}
      onClose={onClose}
      size="lg"
    >
      <form onSubmit={submit}>
        <Field
          label="Mã trong kho"
          required
          hint="Tên gọi nội bộ để nhân viên kho dễ tìm. VD: CAM_BAN_01 cho camera ở Bàn 01."
        >
          <input
            required
            value={form.device_code}
            onChange={(e) =>
              setForm({ ...form, device_code: e.target.value })
            }
            placeholder={
              form.device_type === "camera"
                ? "CAM_BAN_01"
                : "SCANNER_BAN_01"
            }
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono uppercase"
          />
        </Field>
        <Field label="Loại" required>
          <Select
            value={form.device_type}
            onChange={(v) => setForm({ ...form, device_type: v as DeviceType })}
            options={[
              { value: "scanner", label: DEVICE_TYPE_LABEL.scanner },
              { value: "camera", label: DEVICE_TYPE_LABEL.camera },
            ]}
          />
        </Field>
        <Field label="Tên" required>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={
              form.device_type === "camera"
                ? "Camera Bàn 01"
                : "Máy quét Bàn 01"
            }
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>

        {form.device_type === "camera" ? (
          <>
            <Field
              label="Camera sẽ dùng"
              required
              hint={
                camerasLoading
                  ? "Đang tải danh sách camera..."
                  : "Camera phải được khai báo trước ở trang Camera. Mỗi camera chỉ phục vụ 1 bàn cùng lúc."
              }
            >
              {camerasLoading ? (
                <div className="h-10 px-3 rounded-xl border border-slate-200 text-sm inline-flex items-center text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Đang tải...
                </div>
              ) : cameraOptions.length === 0 ? (
                <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                  Chưa có camera nào trong hệ thống.{" "}
                  <a
                    href="/dashboard/devices?type=camera"
                    className="underline font-medium hover:text-amber-900"
                  >
                    Sang trang Camera
                  </a>{" "}
                  để khai báo trước.
                </p>
              ) : (
                <Select
                  value={form.camera_id}
                  onChange={(v) => setForm({ ...form, camera_id: v })}
                  options={cameraOptions}
                  placeholder="Chọn camera..."
                />
              )}
            </Field>
            <Field label="">
              <label
                className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                title="Hệ thống sẽ ưu tiên camera này để tạo clip bằng chứng cho các đơn được quét tại bàn."
              >
                <input
                  type="checkbox"
                  checked={form.camera_role_primary}
                  onChange={(e) =>
                    setForm({ ...form, camera_role_primary: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                Camera chính của bàn
              </label>
            </Field>
          </>
        ) : form.device_type === "scanner" ? (
          <Field
            label="Ghép máy quét đang cắm"
            hint={
              mode === "create"
                ? "Bỏ trống nếu thiết bị chưa cắm — có thể ghép sau bằng cách sửa."
                : "Chọn cổng khác để chuyển sang scanner vật lý khác, hoặc bỏ chọn để gỡ ghép."
            }
          >
            <ScannerPortPicker
              agents={scannerAgents}
              agentId={scannerAgentId}
              onAgentChange={setScannerAgentId}
              onRefresh={refreshAgents}
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
        ) : (
          <Field label="Cấu hình (JSON)" hint="Tuỳ chọn theo loại thiết bị.">
            <textarea
              value={form.config_json_text}
              onChange={(e) =>
                setForm({ ...form, config_json_text: e.target.value })
              }
              rows={4}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono"
            />
          </Field>
        )}

        {mode === "edit" && (
          <Field label="Trạng thái">
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v })}
              options={[
                { value: "active", label: "Hoạt động" },
                { value: "inactive", label: "Ngừng" },
                { value: "archived", label: "Lưu trữ" },
              ]}
            />
          </Field>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Lưu
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AssignDialog({
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
  const [stationId, setStationId] = useState(
    device.current_station?.station_id ?? stations[0]?.id ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!stationId) {
      setErr("Vui lòng chọn bàn.");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/station-device-assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: device.id, station_id: stationId }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.message ?? data.error ?? "Gán thất bại");
      return;
    }
    onSaved();
  };

  return (
    <Modal
      title={`Gán ${device.device_code} vào bàn`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Field label="Chọn bàn" required>
          {stations.length === 0 ? (
            <p className="text-sm text-slate-500">
              Kho này chưa có bàn. Vào tab &quot;Bàn đóng hàng&quot; để tạo trước.
            </p>
          ) : (
            <Select
              value={stationId}
              onChange={(v) => setStationId(v)}
              options={stations.map((s) => ({
                value: s.id,
                label: `${s.code} — ${s.name}`,
              }))}
            />
          )}
        </Field>
        {device.current_station && (
          <p className="text-[11px] text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mb-2">
            Đang gán <b>{device.current_station.station_code}</b>. Gán bàn mới sẽ
            tự đóng mapping cũ với lịch sử.
          </p>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-xl border border-slate-200 text-sm"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={saving || stations.length === 0}
            className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LinkIcon className="h-4 w-4" />
            )}
            Gán
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface AgentRow {
  id: string;
  code: string;
  name: string;
  status: string;
  last_seen_at: string | null;
  last_discovered_at: string | null;
  last_discovered_scanners: Array<{
    path: string;
    identity: DeviceIdentity;
    match: { device_id: string; device_code: string; match_kind: string } | null;
  }> | null;
}

/**
 * Inline picker used inside the "Thêm thiết bị" form for scanner devices.
 * Reads live discovery from /api/warehouse/agents. Picking a row sets
 * `device_identity` on the parent form so the device is born paired —
 * no separate Pair step needed for the common case.
 *
 * Auto-pick rule: if the org has exactly one agent, no dropdown is shown.
 * Otherwise the operator picks which machine's USB list to read from.
 */
export function ScannerPortPicker({
  agents,
  agentId,
  onAgentChange,
  onRefresh,
  ports,
  pickedPath,
  pickedIdentity,
  onPick,
  onClear,
}: {
  agents: AgentRow[] | null;
  agentId: string;
  onAgentChange: (v: string) => void;
  onRefresh: () => void;
  ports: Array<{
    path: string;
    identity: DeviceIdentity;
    match: { device_id: string; device_code: string; match_kind: string } | null;
  }>;
  pickedPath: string;
  pickedIdentity: DeviceIdentity | null;
  onPick: (path: string, identity: DeviceIdentity) => void;
  onClear: () => void;
}) {
  if (agents === null) {
    return (
      <p className="text-xs text-slate-400 inline-flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Đang tải agent...
      </p>
    );
  }
  if (agents.length === 0) {
    return (
      <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
        Chưa có agent nào chạy. Bạn vẫn có thể lưu slot này — ghép sau khi đã
        cài và chạy agent ở máy local.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {agents.length > 1 && (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Select
              value={agentId}
              onChange={onAgentChange}
              options={agents.map((a) => ({
                value: a.id,
                label: `${a.code} — ${a.name}`,
              }))}
            />
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="h-9 px-2.5 rounded-lg border border-slate-200 text-xs inline-flex items-center gap-1"
          >
            <RefreshCcw className="h-3 w-3" /> Làm mới
          </button>
        </div>
      )}
      {agents.length === 1 && (
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>
            Agent: <span className="font-mono">{agents[0].code}</span>
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="h-7 px-2 rounded-lg border border-slate-200 text-xs inline-flex items-center gap-1"
          >
            <RefreshCcw className="h-3 w-3" /> Làm mới
          </button>
        </div>
      )}

      {pickedIdentity && !pickedPath && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
          <span>
            Đang ghép với{" "}
            <span className="font-mono">
              {pickedIdentity.serial_number
                ? `SN ${pickedIdentity.serial_number}`
                : pickedIdentity.vid && pickedIdentity.pid
                  ? `${pickedIdentity.vid}:${pickedIdentity.pid}`
                  : "thiết bị đã lưu"}
            </span>{" "}
            — hiện chưa thấy trong danh sách (chưa cắm hoặc agent offline).
          </span>
          <button
            type="button"
            onClick={onClear}
            className="text-amber-700 underline whitespace-nowrap"
          >
            Bỏ ghép
          </button>
        </div>
      )}

      {(() => {
        // Hide Windows-virtual Bluetooth-link COM ports — these are always
        // created in pairs by the OS and have never been a real barcode
        // scanner. Showing them just adds noise to the picker.
        const realPorts = ports.filter((p) => {
          const fn = (p.identity?.friendly_name ?? "").toLowerCase();
          const mf = (p.identity?.manufacturer ?? "").toLowerCase();
          return !(fn.includes("bluetooth") && mf === "microsoft");
        });
        const hidden = ports.length - realPorts.length;
        if (realPorts.length === 0) {
          return (
            <p className="text-xs text-slate-500 bg-slate-50 px-3 py-2 rounded-lg">
              {hidden > 0
                ? `Đã ẩn ${hidden} cổng Bluetooth ảo của Windows. Cắm scanner USB rồi bấm "Làm mới".`
                : 'Agent này chưa thấy cổng nào. Cắm scanner rồi bấm "Làm mới".'}
            </p>
          );
        }
        return (
          <>
            {hidden > 0 && (
              <p className="text-[11px] text-slate-400 px-1">
                Đã ẩn {hidden} cổng Bluetooth ảo của Windows.
              </p>
            )}
            <ul className="border border-slate-100 rounded-lg divide-y divide-slate-100 overflow-hidden max-h-56 overflow-y-auto">
              {realPorts.map((p) => {
            const id = p.identity ?? {};
            const desc = [id.manufacturer, id.product, id.friendly_name]
              .filter(Boolean)
              .join(" · ");
            const unique = !!id.serial_number || !!id.pnp_id;
            const claimed = p.match && p.match.device_code;
            const picked = pickedPath === p.path;
            return (
              <li
                key={p.path}
                className={`px-3 py-2 flex items-center gap-3 ${
                  picked ? "bg-emerald-50" : "hover:bg-slate-50"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm font-semibold">
                    {p.path}
                    {claimed && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                        đang ghép: {claimed}
                      </span>
                    )}
                  </div>
                  {desc && (
                    <div className="text-[11px] text-slate-500 truncate">
                      {desc}
                    </div>
                  )}
                  {!unique && (
                    <div className="text-[10px] text-amber-600">
                      Không có định danh duy nhất — có thể cần ghép lại khi đổi
                      cổng USB.
                    </div>
                  )}
                </div>
                {picked ? (
                  <button
                    type="button"
                    onClick={onClear}
                    className="h-7 px-2.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-semibold"
                  >
                    Đã chọn ✓
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPick(p.path, id)}
                    className="h-7 px-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold"
                  >
                    Chọn
                  </button>
                )}
              </li>
            );
          })}
            </ul>
          </>
        );
      })()}
    </div>
  );
}
