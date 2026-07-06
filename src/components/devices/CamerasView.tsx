"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Radar,
  RotateCw,
  Save,
  Search,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import { Modal, Field } from "@/components/warehouse-config/Modal";

export interface Camera {
  id: string;
  name: string;
  camera_code: string;
  ip: string;
  rtsp_port: number;
  username: string;
  rtsp_path: string;
  location: string | null;
  status: "active" | "inactive" | "error";
  last_tested_at: string | null;
  last_test_result: { success?: boolean; message?: string } | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
  current_station: {
    station_id: string;
    station_code: string;
    station_name: string;
    warehouse_id: string;
    is_primary: boolean;
  } | null;
  // 1.2: codec onboard-probe. Optional để tương thích với payload cũ.
  codec_detected?: string | null;
  codec_warning?: string | null;
  codec_probed_at?: string | null;
  codec_probe_error?: string | null;
  // Lát 2: agent TCP-probe RTSP port. Optional để tương thích với
  // payload cũ (nếu API chưa được deploy fix mới).
  last_probe_at?: string | null;
  last_probe_ok?: boolean | null;
  last_probe_latency_ms?: number | null;
  camera_online_state?: "online" | "offline" | "warehouse_disconnected" | "not_probed";
}

export interface RecordingSession {
  id: string;
  status: "recording" | "stopped" | "error";
  transport: "tcp" | "udp";
  segment_seconds: number;
  output_dir: string;
  started_at: string;
  stopped_at: string | null;
  error_message: string | null;
}

export type RecordingUiState =
  | "recording"
  | "agent_disconnected"
  | "stopped"
  | "error"
  | "unknown";

export interface RecordingStatus {
  ui_state: RecordingUiState;
  is_recording: boolean;
  session: RecordingSession | null;
  agent_last_seen_at: string | null;
}

export interface LatestFile {
  id: string;
  file_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  status: "ready" | "missing" | "corrupted";
}

export type RecordingInfo = {
  status: RecordingStatus | null;
  latestFile: LatestFile | null;
};

// "Trạng thái ghi" đọc thẳng từ ui_state của backend — backend đã hợp
// nhất session.status + heartbeat + agent.last_seen_at thành 1 kết luận.
type RecState = RecordingUiState;

function deriveRecState(rec: RecordingInfo | undefined): RecState {
  if (!rec || !rec.status) return "unknown";
  return rec.status.ui_state;
}

const REC_BADGE: Record<RecState, { label: string; cls: string; dot: string }> = {
  recording: {
    label: "Đang ghi",
    cls: "bg-red-50 text-red-700",
    dot: "bg-red-500 animate-pulse",
  },
  agent_disconnected: {
    label: "Agent mất kết nối",
    cls: "bg-amber-50 text-amber-700",
    dot: "bg-amber-500",
  },
  error: {
    label: "Lỗi ghi",
    cls: "bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
  },
  stopped: {
    label: "Đã dừng",
    cls: "bg-slate-100 text-slate-600",
    dot: "bg-slate-400",
  },
  unknown: {
    label: "Chưa rõ",
    cls: "bg-slate-50 text-slate-500",
    dot: "bg-slate-300",
  },
};

// ----------------------------------------------------------------------------
// Create / Edit dialog
//
// Create mode shows two tabs:
//   - "Tự tìm camera" (default): scans the LAN, lets the user click a
//     discovered IP, then prompts for credentials + path before testing
//     and saving in one shot.
//   - "Thêm thủ công": the original full form, used as a fallback for
//     cameras on a different subnet or with non-standard endpoints.
//
// Edit mode skips tabs entirely and goes straight to the manual form —
// you don't rediscover a camera you've already configured.
// ----------------------------------------------------------------------------

type CreateTab = "discover" | "manual";

export function CameraDialog({
  mode,
  initial,
  cameras,
  recMap,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Camera;
  cameras?: Camera[];
  recMap?: Record<string, RecordingInfo>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const title = mode === "create" ? "Thêm camera" : `Sửa: ${initial?.name}`;
  return (
    <Modal title={title} onClose={onClose} size="lg">
      <CameraDialogBody
        mode={mode}
        initial={initial}
        cameras={cameras}
        recMap={recMap}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  );
}

// Body-only variant: same UI minus the outer Modal wrapper, so callers
// that already own a modal (e.g. the unified "Thêm thiết bị" dialog) can
// embed the camera flow without nesting modals.
export function CameraDialogBody({
  mode,
  initial,
  cameras,
  recMap,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Camera;
  cameras?: Camera[];
  recMap?: Record<string, RecordingInfo>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<CreateTab>("discover");
  // Allow the "Tự tìm camera" flow to hand a pre-filled IP/port off to
  // the manual tab when the user clicks "Thêm thủ công" from an error
  // state, so they don't lose what they were trying.
  const [manualPrefill, setManualPrefill] = useState<Partial<Camera> | null>(
    null,
  );

  return (
    <>
      {mode === "create" && (
        <div className="-mt-1 mb-4 border-b border-slate-100">
          <nav className="flex gap-4">
            {([
              { key: "discover", label: "Tự tìm camera", icon: Radar },
              { key: "manual", label: "Thêm thủ công", icon: Pencil },
            ] as const).map((t) => {
              const active = tab === t.key;
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`relative pb-3 text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
                    active
                      ? "text-emerald-700"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                  <span
                    className={`absolute left-0 right-0 -bottom-px h-0.5 rounded-full ${
                      active ? "bg-emerald-500" : "bg-transparent"
                    }`}
                  />
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {mode === "create" && tab === "discover" && (
        <DiscoverTab
          cameras={cameras ?? []}
          recMap={recMap ?? {}}
          onSwitchToManual={(prefill) => {
            setManualPrefill(prefill ?? null);
            setTab("manual");
          }}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
      {(mode === "edit" || tab === "manual") && (
        <ManualForm
          mode={mode}
          initial={initial ?? (manualPrefill as Camera | undefined)}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------------------------
// Manual form (the original create/edit flow)
// ----------------------------------------------------------------------------

function ManualForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Partial<Camera>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    camera_code: initial?.camera_code ?? "",
    ip: initial?.ip ?? "",
    rtsp_port: initial?.rtsp_port ?? 554,
    username: initial?.username ?? "admin",
    password: "",
    rtsp_path: initial?.rtsp_path ?? "/ch1/main",
    location: initial?.location ?? "",
    // Chỉ dùng ở mode=edit — cho user bật/tắt camera. status='error' được
    // set bởi system (test-connection fail) → không cho chọn từ dropdown.
    status: (initial?.status === "inactive" ? "inactive" : "active") as
      | "active"
      | "inactive",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSaving(true);
    const body: Record<string, unknown> = {
      name: form.name,
      camera_code: form.camera_code,
      ip: form.ip,
      rtsp_port: Number(form.rtsp_port),
      username: form.username,
      rtsp_path: form.rtsp_path,
      location: form.location,
    };
    if (mode === "create" || form.password.length > 0) {
      body.password = form.password;
    }
    if (mode === "edit") {
      body.status = form.status;
    }
    const url =
      mode === "create" ? "/api/cameras" : `/api/cameras/${initial!.id}`;
    const method = mode === "create" ? "POST" : "PUT";
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

  return (
    <form onSubmit={submit}>
      <Field label="Tên camera" required>
        <input
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Camera Bàn đóng hàng 1"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
        />
      </Field>
      <Field label="Mã camera" required hint="Chỉ chữ, số, _ và -. VD: cam_01">
        <input
          required
          value={form.camera_code}
          onChange={(e) => setForm({ ...form, camera_code: e.target.value })}
          placeholder="cam_01"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="IP camera" required>
          <input
            required
            value={form.ip}
            onChange={(e) => setForm({ ...form, ip: e.target.value })}
            placeholder="192.168.88.141"
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </Field>
        <Field label="RTSP port" required>
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={form.rtsp_port}
            onChange={(e) =>
              setForm({ ...form, rtsp_port: Number(e.target.value) })
            }
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Username" required>
          <input
            required
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="admin"
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <Field
          label={
            mode === "edit"
              ? "Mật khẩu (để trống = giữ nguyên)"
              : "Mật khẩu / Verification code"
          }
          required={mode === "create"}
          hint={
            mode === "edit"
              ? "Chỉ nhập nếu muốn đổi mật khẩu."
              : "Hỗ trợ ký tự đặc biệt — server sẽ tự URL-encode."
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            required={mode === "create"}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder={mode === "edit" ? "••••••••" : ""}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </Field>
      </div>

      <Field label="RTSP path" required hint="VD: /ch1/main">
        <input
          required
          value={form.rtsp_path}
          onChange={(e) => setForm({ ...form, rtsp_path: e.target.value })}
          placeholder="/ch1/main"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
        />
      </Field>

      <Field label="Vị trí" hint="VD: Bàn đóng hàng 1">
        <input
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.target.value })}
          placeholder="Bàn đóng hàng 1"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
        />
      </Field>

      {mode === "edit" && (
        <Field
          label="Trạng thái"
          hint="Tạm ngưng = agent không probe, không cho Bắt đầu ghi."
        >
          <Select
            value={form.status}
            onChange={(v) =>
              setForm({
                ...form,
                status: v as "active" | "inactive",
              })
            }
            options={[
              { value: "active", label: "Đang hoạt động" },
              { value: "inactive", label: "Tạm ngưng" },
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
  );
}

// ----------------------------------------------------------------------------
// Auto-discovery tab
// ----------------------------------------------------------------------------

interface DiscoveredDevice {
  ip: string;
  open_ports: number[];
  rtsp_port: number | null;
  web_ports: number[];
  onvif_detected: boolean;
  onvif_xaddr?: string | null;
  vendor: string | null;
  model: string | null;
  confidence: "onvif_camera" | "likely_camera" | "needs_check";
  suggested_rtsp_paths: string[];
  subnet?: string;
  already_added?: boolean;
}

interface CandidateSubnet {
  cidr: string;
  interface_name: string;
  is_virtual: boolean;
}

type ScanMode = "quick" | "full";

interface DiscoverResponse {
  scan_mode?: ScanMode;
  scanned_subnets?: string[];
  selected_subnet: string;
  available_subnets?: CandidateSubnet[];
  devices: DiscoveredDevice[];
  // older field name still emitted by the server for back-compat
  subnet?: string;
}

interface DiscoverErrorResponse {
  error: string;
  message?: string;
  available_subnets?: CandidateSubnet[];
}

type DiscoverState =
  | { kind: "idle" }
  | { kind: "scanning"; subnet: string; mode: ScanMode }
  | {
      kind: "result";
      subnet: string;
      scanned_subnets: string[];
      mode: ScanMode;
      devices: DiscoveredDevice[];
      candidates: CandidateSubnet[];
    }
  | {
      kind: "error";
      message: string;
      candidates: CandidateSubnet[];
    };

function isValidPrivateCidrSlash24OrSmaller(cidr: string): boolean {
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const prefix = Number(m[5]);
  if (prefix < 24 || prefix > 32) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// Friendly subnet label for non-technical users. We strip the CIDR mask
// and turn the trailing 0 into "x" so the operator sees the same string
// they'd read off their router sticker ("Mạng 192.168.22.x") rather than
// a /24 they can't reason about. The full CIDR still rides along in the
// `title` attribute so support can copy it verbatim when needed.
function friendlySubnet(cidr: string): string {
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/\d{1,2}$/);
  if (!m) return cidr;
  return `${m[1]}.${m[2]}.${m[3]}.x`;
}

function interfaceLabel(c: CandidateSubnet): string {
  const n = c.interface_name.toLowerCase();
  if (c.is_virtual) return "Mạng ảo";
  if (n.includes("wi-fi") || n.includes("wifi") || n.includes("wlan")) {
    return "Mạng Wi-Fi";
  }
  if (n.includes("ethernet") || n.includes("eth") || n.includes("lan")) {
    return "Mạng dây";
  }
  return "Mạng nội bộ";
}

// Plain-language one-liner describing what the open ports likely mean.
// We deliberately avoid port numbers and the words "RTSP" / "ONVIF" /
// "Web 8000" in the visible string — those go in the title tooltip so
// power users can still inspect them.
function describeDevice(d: DiscoveredDevice): {
  visible: string;
  technical: string;
} {
  const bits: string[] = [];
  if (d.rtsp_port) bits.push("Có cổng camera");
  if (d.web_ports.length > 0) bits.push("Có trang quản trị");
  if (d.onvif_detected) bits.push("Hỗ trợ ONVIF");
  if (bits.length === 0) bits.push("Thiết bị mạng / cần kiểm tra");

  const techParts: string[] = [];
  if (d.rtsp_port) techParts.push(`RTSP ${d.rtsp_port}`);
  if (d.web_ports.length > 0) techParts.push(`Web ${d.web_ports.join(", ")}`);
  if (d.onvif_detected) techParts.push("ONVIF");
  const technical = techParts.length > 0 ? techParts.join(" · ") : "Không có port camera";

  return { visible: bits.join(" · "), technical };
}

function DiscoverTab({
  cameras,
  recMap,
  onSwitchToManual,
  onClose,
  onSaved,
}: {
  cameras: Camera[];
  recMap: Record<string, RecordingInfo>;
  onSwitchToManual: (prefill?: Partial<Camera>) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [state, setState] = useState<DiscoverState>({ kind: "idle" });
  const [selected, setSelected] = useState<DiscoveredDevice | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  // Index existing cameras by IP so each "already_added" row can pick up
  // its recording badge without an extra fetch.
  const camerasByIp = useMemo(() => {
    const m = new Map<string, Camera>();
    for (const c of cameras) m.set(c.ip, c);
    return m;
  }, [cameras]);

  // Subnet currently selected in the dropdown / typed by the user.
  // Kept separate from `state` so the dropdown doesn't reset between
  // scans and so the user can pick a subnet before the first scan.
  const [pickedCidr, setPickedCidr] = useState<string>("");
  const [customCidr, setCustomCidr] = useState<string>("");
  const [customMode, setCustomMode] = useState<boolean>(false);
  const [customErr, setCustomErr] = useState<string>("");

  // Candidates discovered from the server's network interfaces. We
  // populate these on first scan and reuse for subsequent picks.
  const [candidates, setCandidates] = useState<CandidateSubnet[]>([]);

  const runScan = useCallback(
    async (opts?: { cidr?: string; mode?: ScanMode }) => {
      setSelected(null);
      const mode: ScanMode = opts?.mode ?? "quick";
      // Quick mode: scan the picked subnet (or auto). Full mode: scan
      // ALL detected private subnets at once unless the user explicitly
      // pinned one via the dropdown.
      const cidr = (opts?.cidr ?? (mode === "quick" ? pickedCidr : "") ?? "").trim();
      setState({
        kind: "scanning",
        subnet: cidr || (mode === "full" ? "tất cả mạng nội bộ" : "—"),
        mode,
      });
      try {
        const body: Record<string, unknown> = { mode };
        if (cidr) body.cidr = cidr;
        const res = await fetch("/api/cameras/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        });
        const data = (await res.json()) as
          | DiscoverResponse
          | DiscoverErrorResponse;
        if (!res.ok) {
          const err = data as DiscoverErrorResponse;
          if (err.available_subnets) setCandidates(err.available_subnets);
          setState({
            kind: "error",
            message: err.message ?? err.error ?? "Không quét được mạng.",
            candidates: err.available_subnets ?? candidates,
          });
          return;
        }
        const payload = data as DiscoverResponse;
        const subnet = payload.selected_subnet ?? payload.subnet ?? cidr;
        const scanned = payload.scanned_subnets ?? (subnet ? [subnet] : []);
        const nextCandidates = payload.available_subnets ?? candidates;
        if (payload.available_subnets) setCandidates(payload.available_subnets);
        // Lock the dropdown onto the FIRST scanned subnet so "Quét lại"
        // hits a known target. In multi-subnet scans this is the
        // top-ranked one — the dropdown shows the rest in `candidates`.
        if (scanned[0]) setPickedCidr(scanned[0]);
        setState({
          kind: "result",
          subnet,
          scanned_subnets: scanned,
          mode: payload.scan_mode ?? mode,
          devices: payload.devices,
          candidates: nextCandidates,
        });
      } catch (e) {
        setState({
          kind: "error",
          message: (e as Error).message ?? "Không quét được mạng.",
          candidates,
        });
      }
    },
    [pickedCidr, candidates],
  );

  // Selected-state form
  if (selected) {
    return (
      <DiscoveredDeviceForm
        device={selected}
        onBack={() => setSelected(null)}
        onSwitchToManual={() =>
          onSwitchToManual({
            ip: selected.ip,
            rtsp_port: selected.rtsp_port ?? 554,
            rtsp_path: selected.suggested_rtsp_paths[0] ?? "/ch1/main",
          })
        }
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }

  const visibleCandidates = candidates;
  const showSubnetPicker =
    visibleCandidates.length > 0 || state.kind !== "idle";

  const applyCustom = () => {
    const v = customCidr.trim();
    if (!isValidPrivateCidrSlash24OrSmaller(v)) {
      setCustomErr(
        "CIDR không hợp lệ. Chỉ chấp nhận mạng nội bộ /24-/32 (vd 192.168.22.0/24).",
      );
      return;
    }
    setCustomErr("");
    setPickedCidr(v);
    setCustomMode(false);
    void runScan({ cidr: v, mode: "quick" });
  };

  return (
    <div className="space-y-4">
      {showSubnetPicker && (
        <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-500 shrink-0">
              Mạng đang quét
            </span>
            {!customMode && (
              <select
                value={pickedCidr}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__custom") {
                    setCustomMode(true);
                    setCustomCidr(pickedCidr || "");
                  } else {
                    setPickedCidr(v);
                  }
                }}
                title={pickedCidr || undefined}
                className="h-9 px-2 rounded-lg border border-slate-200 text-xs bg-white flex-1 min-w-0"
              >
                {visibleCandidates.length === 0 && (
                  <option value="">Tự động phát hiện</option>
                )}
                {visibleCandidates.map((c) => (
                  <option key={c.cidr} value={c.cidr} title={c.cidr}>
                    {interfaceLabel(c)} · {friendlySubnet(c.cidr)}
                  </option>
                ))}
                <option value="__custom">Quét mạng khác...</option>
              </select>
            )}
            {customMode && (
              <input
                value={customCidr}
                onChange={(e) => setCustomCidr(e.target.value)}
                placeholder="192.168.22.0/24"
                className="h-9 px-2 rounded-lg border border-slate-200 text-xs font-mono flex-1 min-w-0"
                autoFocus
              />
            )}
            {customMode ? (
              <>
                <button
                  type="button"
                  onClick={applyCustom}
                  className="h-9 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold shrink-0"
                >
                  Quét
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCustomMode(false);
                    setCustomErr("");
                  }}
                  className="h-9 px-2 rounded-lg border border-slate-200 text-xs text-slate-600 shrink-0"
                >
                  Huỷ
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void runScan({ cidr: pickedCidr, mode: "quick" })
                }
                disabled={state.kind === "scanning"}
                className="h-9 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 disabled:opacity-60"
              >
                {state.kind === "scanning" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" />
                )}
                Quét lại
              </button>
            )}
          </div>
          {customErr && (
            <p className="text-[11px] text-rose-600">{customErr}</p>
          )}
        </div>
      )}

      {state.kind === "idle" && (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center">
          <div className="mx-auto h-10 w-10 rounded-full bg-emerald-50 text-emerald-600 inline-flex items-center justify-center mb-3">
            <Radar className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-slate-800">
            Tự tìm camera
          </p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            Hệ thống sẽ tìm camera đang kết nối cùng mạng với máy chạy hệ
            thống. Hỗ trợ camera Wi-Fi hoặc camera cắm dây.
          </p>
          <div className="mt-4 flex justify-center gap-2 flex-wrap">
            <button
              onClick={() => void runScan({ mode: "quick" })}
              className="h-10 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2"
            >
              <Radar className="h-4 w-4" /> Tìm nhanh
            </button>
            <button
              onClick={() => void runScan({ mode: "full" })}
              className="h-10 px-4 rounded-xl border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-700 text-sm font-semibold inline-flex items-center gap-2"
              title="Quét tất cả mạng nội bộ trên máy. Lâu hơn nhưng tìm được nhiều camera hơn."
            >
              <Search className="h-4 w-4" /> Quét toàn mạng
            </button>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Tìm nhanh: 3-5 giây · Quét toàn mạng: 15-30 giây
          </p>
        </div>
      )}

      {state.kind === "scanning" && (
        <div className="rounded-2xl border border-slate-200 p-6 text-center">
          <Loader2 className="h-5 w-5 animate-spin inline text-emerald-600 mr-2" />
          <span className="text-sm text-slate-700">
            {state.mode === "full"
              ? "Đang quét toàn bộ mạng nội bộ"
              : "Đang tìm camera trong mạng"}
            {state.subnet && state.subnet !== "—" && state.mode === "quick" && (
              <>
                {" "}
                <span title={state.subnet}>{friendlySubnet(state.subnet)}</span>
              </>
            )}
            ...
          </span>
          <p className="text-xs text-slate-500 mt-2">
            {state.mode === "full"
              ? "Việc này có thể mất 15-30 giây."
              : "Việc này có thể mất 3-10 giây."}
          </p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-600 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-rose-800">
                Không quét được mạng
              </p>
              <p className="text-xs text-rose-700 mt-0.5">{state.message}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void runScan()}
              className="h-9 px-3 rounded-xl border border-rose-200 bg-white text-rose-700 hover:bg-rose-100 text-xs font-semibold inline-flex items-center gap-2"
            >
              <RotateCw className="h-3.5 w-3.5" /> Thử lại
            </button>
            <button
              onClick={() => onSwitchToManual()}
              className="h-9 px-3 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-semibold inline-flex items-center gap-2"
            >
              <Pencil className="h-3.5 w-3.5" /> Thêm thủ công
            </button>
          </div>
        </div>
      )}

      {state.kind === "result" && (() => {
        // Split devices: cameras (any onvif_* or likely_camera) vs.
        // "Thiết bị khác" (only-web hosts like routers/NAS). The
        // not-a-camera bucket stays collapsed by default so a non-
        // technical user doesn't pick the gateway by mistake.
        const isCamera = (d: DiscoveredDevice) =>
          d.confidence === "onvif_camera" ||
          d.confidence === "likely_camera" ||
          d.onvif_detected;
        const cameraDevices = state.devices.filter(isCamera);
        const otherDevices = state.devices.filter((d) => !isCamera(d));

        const summary: string[] = [];
        summary.push(
          cameraDevices.length === 0
            ? "Chưa tìm thấy camera"
            : `Tìm thấy ${cameraDevices.length} camera`,
        );
        if (otherDevices.length > 0) {
          summary.push(`${otherDevices.length} thiết bị khác cần kiểm tra`);
        }

        // Scope label — "trong 192.168.22.x" for single subnet, or
        // "trong 2 mạng nội bộ" when the user triggered a full scan.
        const scanned = state.scanned_subnets ?? [state.subnet];
        const scopeLabel =
          scanned.length > 1
            ? `trong ${scanned.length} mạng nội bộ`
            : (
                <>
                  trong{" "}
                  <span title={state.subnet}>
                    {friendlySubnet(state.subnet)}
                  </span>
                </>
              );

        return (
          <>
            <p className="text-xs text-slate-500">
              {summary.join(" · ")} {scopeLabel}
              {state.mode === "full" && (
                <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                  Quét toàn mạng
                </span>
              )}
            </p>

            {cameraDevices.length === 0 && otherDevices.length === 0 && (
              <div className="rounded-2xl border border-slate-200 p-6 text-center space-y-3">
                <p className="text-sm text-slate-700">
                  Không tìm thấy camera{" "}
                  {scanned.length > 1 ? (
                    `trong ${scanned.length} mạng nội bộ`
                  ) : (
                    <>
                      trong{" "}
                      <span title={state.subnet}>
                        {friendlySubnet(state.subnet)}
                      </span>
                    </>
                  )}
                  .
                </p>
                <p className="text-xs text-slate-500">
                  Hãy thử quét toàn mạng, chọn mạng khác, hoặc thêm thủ công.
                </p>
                <div className="flex justify-center gap-2 flex-wrap">
                  {state.mode !== "full" && (
                    <button
                      onClick={() => void runScan({ mode: "full" })}
                      className="h-9 px-3 rounded-xl border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-700 text-xs font-semibold inline-flex items-center gap-2"
                    >
                      <Search className="h-3.5 w-3.5" /> Quét toàn mạng
                    </button>
                  )}
                  <button
                    onClick={() => setCustomMode(true)}
                    className="h-9 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold inline-flex items-center gap-2"
                  >
                    <Radar className="h-3.5 w-3.5" /> Chọn mạng khác
                  </button>
                  <button
                    onClick={() => onSwitchToManual()}
                    className="h-9 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold inline-flex items-center gap-2"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Thêm thủ công
                  </button>
                </div>
              </div>
            )}

            {cameraDevices.length > 0 && (
              <ul className="rounded-2xl border border-slate-100 divide-y divide-slate-100 overflow-hidden">
                {cameraDevices.map((d) => (
                  <DeviceRow
                    key={d.ip}
                    device={d}
                    existingCamera={camerasByIp.get(d.ip) ?? null}
                    recording={
                      camerasByIp.get(d.ip)
                        ? recMap[camerasByIp.get(d.ip)!.id]
                        : undefined
                    }
                    onSelect={() => setSelected(d)}
                  />
                ))}
              </ul>
            )}

            {otherDevices.length > 0 && (
              <div className="rounded-2xl border border-slate-100 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowOthers((v) => !v)}
                  className="w-full px-3 py-2 flex items-center justify-between text-left bg-slate-50/50 hover:bg-slate-100"
                >
                  <span className="text-xs font-semibold text-slate-600">
                    Thiết bị khác ({otherDevices.length})
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {showOthers ? "Ẩn" : "Hiện"}
                  </span>
                </button>
                {showOthers && (
                  <ul className="divide-y divide-slate-100">
                    {otherDevices.map((d) => (
                      <DeviceRow
                        key={d.ip}
                        device={d}
                        existingCamera={camerasByIp.get(d.ip) ?? null}
                        recording={
                          camerasByIp.get(d.ip)
                            ? recMap[camerasByIp.get(d.ip)!.id]
                            : undefined
                        }
                        onSelect={() => setSelected(d)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            <p className="text-[11px] text-slate-500">
              Không tìm thấy?{" "}
              <button
                type="button"
                onClick={() => onSwitchToManual()}
                className="text-emerald-700 hover:underline font-semibold"
              >
                Thêm thủ công
              </button>
            </p>
          </>
        );
      })()}
    </div>
  );
}

function DeviceRow({
  device,
  existingCamera,
  recording,
  onSelect,
}: {
  device: DiscoveredDevice;
  existingCamera: Camera | null;
  recording: RecordingInfo | undefined;
  onSelect: () => void;
}) {
  const d = device;
  const { visible, technical } = describeDevice(d);
  const alreadyAdded = !!existingCamera || !!d.already_added;
  const recState = deriveRecState(recording);

  return (
    <li className="px-3 py-2.5 flex items-center gap-3 hover:bg-slate-50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-semibold text-slate-800">
            {d.ip}
          </span>
          {alreadyAdded && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
              <CheckCircle2 className="h-3 w-3" /> Đã thêm vào hệ thống
            </span>
          )}
          {/* Recording badge only when we have one — reuses the parent's
              cached recMap, no extra fetch. */}
          {alreadyAdded && recState !== "unknown" && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${REC_BADGE[recState].cls}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${REC_BADGE[recState].dot}`}
              />
              {REC_BADGE[recState].label}
            </span>
          )}
          {d.confidence === "onvif_camera" ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700"
              title={d.onvif_xaddr ?? undefined}
            >
              <CheckCircle2 className="h-3 w-3" /> Camera ONVIF
            </span>
          ) : d.confidence === "likely_camera" ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> Có thể là camera
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
              Cần kiểm tra
            </span>
          )}
          {d.vendor && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-50 text-violet-700"
              title={d.model ?? undefined}
            >
              {d.vendor}
            </span>
          )}
        </div>
        <p
          className="text-[11px] text-slate-500 mt-0.5"
          title={technical}
        >
          {visible}
        </p>
      </div>
      {alreadyAdded ? (
        <span className="h-8 px-3 rounded-lg border border-slate-200 text-slate-500 text-xs font-semibold inline-flex items-center shrink-0">
          Đã thêm
        </span>
      ) : (
        <button
          onClick={onSelect}
          className="h-8 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold shrink-0"
        >
          Chọn
        </button>
      )}
    </li>
  );
}

function DiscoveredDeviceForm({
  device,
  onBack,
  onSwitchToManual,
  onClose,
  onSaved,
}: {
  device: DiscoveredDevice;
  onBack: () => void;
  onSwitchToManual: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: "",
    camera_code: "",
    username: "admin",
    password: "",
    rtsp_path: device.suggested_rtsp_paths[0] ?? "/ch1/main",
    location: "",
  });
  const [busy, setBusy] = useState<"test" | null>(null);
  const [err, setErr] = useState("");

  // Default port: prefer the open RTSP port if we found one, otherwise 554.
  const rtspPort = device.rtsp_port ?? 554;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy("test");
    try {
      // 1) Probe the RTSP endpoint with the supplied credentials. If this
      // fails we do NOT persist the camera — the user gets a precise
      // error and can correct it in place.
      const testRes = await fetch("/api/cameras/test-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: device.ip,
          rtsp_port: rtspPort,
          username: form.username,
          password: form.password,
          rtsp_path: form.rtsp_path,
        }),
      });
      const testData = await testRes.json().catch(() => ({}));
      if (!testData.success) {
        setErr(testData.message ?? testData.error ?? "Test thất bại.");
        return;
      }

      // 2) Only on a passing probe do we POST to /api/cameras. The DB
      // write path remains the same one the manual form uses, so
      // encryption / RLS / audit are identical.
      const saveRes = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          camera_code: form.camera_code,
          ip: device.ip,
          rtsp_port: rtspPort,
          username: form.username,
          password: form.password,
          rtsp_path: form.rtsp_path,
          location: form.location,
        }),
      });
      const saveData = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setErr(saveData.message ?? saveData.error ?? "Lưu thất bại.");
        return;
      }
      toast.success(`Đã thêm camera ${form.camera_code}`);
      onSaved();
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-[11px] text-emerald-700 font-semibold">
            Thiết bị đã chọn
          </p>
          <p className="text-sm font-mono font-semibold text-emerald-900 mt-0.5">
            {device.ip}:{rtspPort}
          </p>
          <p className="text-[11px] text-emerald-700 mt-0.5">
            {device.vendor ?? "Không xác định"}
            {device.model ? ` · ${device.model}` : ""}
            {device.onvif_detected ? " · ONVIF" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="h-8 px-2.5 rounded-lg border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100 text-xs font-semibold shrink-0"
        >
          Chọn thiết bị khác
        </button>
      </div>

      <Field label="Tên camera" required>
        <input
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Camera Bàn đóng hàng 1"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
        />
      </Field>
      <Field label="Mã camera" required hint="Chỉ chữ, số, _ và -. VD: cam_01">
        <input
          required
          value={form.camera_code}
          onChange={(e) => setForm({ ...form, camera_code: e.target.value })}
          placeholder="cam_01"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Username" required>
          <input
            required
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="admin"
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
        <Field
          label="Mật khẩu / Verification code"
          required
          hint="Nhập mật khẩu camera để kiểm tra."
        >
          <input
            type="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </Field>
      </div>

      <Field
        label="RTSP path"
        required
        hint="Chọn path phổ biến hoặc tự nhập."
      >
        <div className="flex gap-2">
          <select
            value={
              device.suggested_rtsp_paths.includes(form.rtsp_path)
                ? form.rtsp_path
                : "__custom"
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v !== "__custom") setForm({ ...form, rtsp_path: v });
            }}
            className="h-10 px-3 rounded-xl border border-slate-200 text-sm bg-white min-w-[180px]"
          >
            {device.suggested_rtsp_paths.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="__custom">Tuỳ chỉnh...</option>
          </select>
          <input
            required
            value={form.rtsp_path}
            onChange={(e) => setForm({ ...form, rtsp_path: e.target.value })}
            placeholder="/ch1/main"
            className="flex-1 h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono"
          />
        </div>
      </Field>

      <Field label="Vị trí" hint="VD: Bàn đóng hàng 1">
        <input
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.target.value })}
          placeholder="Bàn đóng hàng 1"
          className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
        />
      </Field>

      {err && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <p>{err}</p>
          </div>
          <button
            type="button"
            onClick={onSwitchToManual}
            className="h-8 px-3 rounded-lg bg-white border border-rose-200 text-rose-700 hover:bg-rose-100 text-[11px] font-semibold inline-flex items-center gap-1.5"
          >
            <Pencil className="h-3 w-3" /> Mở thêm thủ công với IP này
          </button>
        </div>
      )}

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
          disabled={busy !== null}
          className="h-9 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
        >
          {busy === "test" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          Test & Lưu
        </button>
      </div>
    </form>
  );
}
