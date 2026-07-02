"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Wrench,
  Plus,
  Pencil,
  Archive,
  Loader2,
  Search,
  Save,
  ScanLine,
  Camera,
  Printer,
  Scale,
  Cpu,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import { Modal, Field } from "@/components/warehouse-config/Modal";

interface Station {
  id: string;
  code: string;
  name: string;
  warehouse_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface WarehouseRef {
  id: string;
  code: string;
  name: string;
}

type DeviceType = "scanner" | "camera" | "printer" | "scale";

interface StationDevice {
  id: string;
  device_code: string;
  device_type: DeviceType | string;
  name: string;
  status: string;
  connection_status?: string | null;
  current_station: {
    station_id: string;
    station_code: string;
    station_name: string;
    warehouse_id: string;
    assigned_at: string;
  } | null;
}

const DEVICE_ICON: Record<string, typeof Cpu> = {
  scanner: ScanLine,
  camera: Camera,
  printer: Printer,
  scale: Scale,
};

const DEVICE_LABEL: Record<string, string> = {
  scanner: "Máy quét",
  camera: "Camera",
  printer: "Máy in",
  scale: "Cân",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Hoạt động",
  inactive: "Ngừng",
  archived: "Đã lưu trữ",
};

const STATUS_COLOR: Record<string, string> = {
  active: "text-emerald-600",
  inactive: "text-slate-400",
  archived: "text-slate-400",
};

export default function PackingStationsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [stations, setStations] = useState<Station[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseRef[]>([]);
  const [devices, setDevices] = useState<StationDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filterWarehouse, setFilterWarehouse] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("active");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Station | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [stRes, whRes, devRes] = await Promise.all([
      fetch("/api/packing-stations", { cache: "no-store" }),
      fetch("/api/warehouses", { cache: "no-store" }),
      fetch("/api/station-devices", { cache: "no-store" }),
    ]);
    const stData = await stRes.json();
    const whData = await whRes.json();
    const devData = await devRes.json();
    if (!stRes.ok) {
      setError(stData.message ?? stData.error ?? "Không tải được danh sách bàn.");
      setLoading(false);
      return;
    }
    if (!whRes.ok) {
      setError(whData.message ?? whData.error ?? "Không tải được danh sách kho.");
      setLoading(false);
      return;
    }
    setStations(stData.stations ?? []);
    setWarehouses(whData.warehouses ?? []);
    // Thiết bị có thể bị chặn permission cho vài role — không coi là lỗi.
    setDevices(devRes.ok ? (devData.devices ?? []) : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const warehouseById = useMemo(() => {
    const m = new Map<string, WarehouseRef>();
    warehouses.forEach((w) => m.set(w.id, w));
    return m;
  }, [warehouses]);

  const devicesByStation = useMemo(() => {
    const m = new Map<string, StationDevice[]>();
    for (const d of devices) {
      if (!d.current_station) continue;
      const arr = m.get(d.current_station.station_id) ?? [];
      arr.push(d);
      m.set(d.current_station.station_id, arr);
    }
    // Sắp xếp theo loại: camera, scanner, printer, scale, khác
    const order: Record<string, number> = {
      camera: 0,
      scanner: 1,
      printer: 2,
      scale: 3,
    };
    for (const arr of m.values()) {
      arr.sort(
        (a, b) =>
          (order[a.device_type] ?? 99) - (order[b.device_type] ?? 99) ||
          a.device_code.localeCompare(b.device_code),
      );
    }
    return m;
  }, [devices]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stations.filter((s) => {
      if (filterWarehouse !== "all" && s.warehouse_id !== filterWarehouse)
        return false;
      if (filterStatus !== "all" && s.status !== filterStatus) return false;
      if (!needle) return true;
      const wh = warehouseById.get(s.warehouse_id);
      return (
        s.code.toLowerCase().includes(needle) ||
        s.name.toLowerCase().includes(needle) ||
        (wh?.code.toLowerCase().includes(needle) ?? false) ||
        (wh?.name.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [stations, q, filterWarehouse, filterStatus, warehouseById]);

  const activeCount = stations.filter((s) => s.status === "active").length;
  const archivedCount = stations.filter((s) => s.status !== "active").length;

  const onArchive = async (st: Station) => {
    const wh = warehouseById.get(st.warehouse_id);
    const ok = await confirm({
      title: "Lưu trữ bàn?",
      message: (
        <>
          Bàn <b>{st.name}</b> ({st.code}) tại kho{" "}
          <b>{wh ? `${wh.code} · ${wh.name}` : "—"}</b> sẽ chuyển sang lưu trữ.
          Phiên đang hoạt động (nếu có) phải được kết thúc trước.
        </>
      ),
      confirmLabel: "Lưu trữ",
      variant: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/packing-stations/${st.id}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Lưu trữ thất bại");
      return;
    }
    toast.success(`Đã lưu trữ ${st.code}`);
    load();
  };

  const warehouseOptions = useMemo(
    () => [
      { value: "all", label: "Tất cả kho" },
      ...warehouses.map((w) => ({
        value: w.id,
        label: `${w.code} · ${w.name}`,
      })),
    ],
    [warehouses],
  );

  return (
    <DashboardLayout
      pageTitle="Bàn đóng hàng"
      pageSubtitle="Toàn bộ bàn đóng hàng trong các kho của tổ chức"
      pageIcon={Wrench}
    >
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 h-9 px-3 rounded-xl border border-slate-200 bg-slate-50/60 text-slate-500 flex-1 max-w-sm">
            <Search className="h-4 w-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm mã/tên bàn, mã/tên kho..."
              className="bg-transparent text-sm outline-none flex-1 placeholder:text-slate-400"
            />
          </div>
          <div className="w-56">
            <Select
              value={filterWarehouse}
              onChange={setFilterWarehouse}
              options={warehouseOptions}
            />
          </div>
          <div className="w-44">
            <Select
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: "all", label: "Mọi trạng thái" },
                { value: "active", label: "Hoạt động" },
                { value: "inactive", label: "Ngừng" },
                { value: "archived", label: "Đã lưu trữ" },
              ]}
            />
          </div>
          <button
            onClick={() => setShowCreate(true)}
            disabled={warehouses.length === 0}
            className="ml-auto h-9 px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Thêm bàn
          </button>
        </div>

        <div className="px-4 py-2.5 border-b border-slate-100 text-xs text-slate-500">
          {activeCount} bàn đang hoạt động
          {archivedCount > 0 && ` · ${archivedCount} đã lưu trữ`}
        </div>

        {error && (
          <div className="px-4 py-3 bg-red-50 text-red-600 text-sm border-b border-red-100">
            {error}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60">
              <tr className="text-left text-[11px] tracking-wider text-slate-500">
                <th className="px-4 py-3 font-semibold w-32">Mã bàn</th>
                <th className="px-4 py-3 font-semibold">Tên bàn</th>
                <th className="px-4 py-3 font-semibold">Kho</th>
                <th className="px-4 py-3 font-semibold">Thiết bị đang gán</th>
                <th className="px-4 py-3 font-semibold w-32">Trạng thái</th>
                <th className="px-4 py-3 font-semibold text-right whitespace-nowrap w-40">
                  <span className="inline-block w-24 text-center">Hành động</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Đang tải...
                  </td>
                </tr>
              )}
              {!loading && warehouses.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400 text-sm">
                    Chưa có kho nào. Tạo kho trước khi thêm bàn.
                  </td>
                </tr>
              )}
              {!loading && warehouses.length > 0 && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400 text-sm">
                    Không có bàn nào khớp bộ lọc.
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                const wh = warehouseById.get(s.warehouse_id);
                const stDevices = devicesByStation.get(s.id) ?? [];
                return (
                  <tr
                    key={s.id}
                    className="border-t border-slate-100 hover:bg-slate-50/60"
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-slate-800">
                      {s.code}
                    </td>
                    <td className="px-4 py-3 text-slate-800">{s.name}</td>
                    <td className="px-4 py-3 text-slate-700 text-xs">
                      {wh ? (
                        <span>
                          <span className="font-mono font-semibold text-slate-800">
                            {wh.code}
                          </span>{" "}
                          · {wh.name}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <DeviceChips devices={stDevices} />
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs font-medium ${
                          STATUS_COLOR[s.status] ?? "text-slate-400"
                        }`}
                      >
                        {STATUS_LABEL[s.status] ?? s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-center gap-1 w-24">
                        <button
                          onClick={() => setEditing(s)}
                          className="h-8 w-8 rounded-lg hover:bg-slate-100 inline-flex items-center justify-center text-slate-600"
                          title="Sửa"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {s.status === "active" && (
                          <button
                            onClick={() => onArchive(s)}
                            className="h-8 w-8 rounded-lg hover:bg-amber-50 inline-flex items-center justify-center text-amber-600"
                            title="Lưu trữ"
                          >
                            <Archive className="h-4 w-4" />
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

      {showCreate && (
        <StationDialog
          mode="create"
          warehouses={warehouses}
          defaultWarehouseId={
            filterWarehouse !== "all" ? filterWarehouse : warehouses[0]?.id
          }
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editing && (
        <StationDialog
          mode="edit"
          warehouses={warehouses}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </DashboardLayout>
  );
}

const CONN_STATUS_LABEL: Record<string, string> = {
  online: "Đang kết nối",
  offline: "Mất kết nối",
  error: "Lỗi",
  unknown: "Chưa kết nối",
};

function DeviceChips({ devices }: { devices: StationDevice[] }) {
  if (devices.length === 0) {
    return (
      <span className="text-xs text-slate-400 italic">Chưa gán thiết bị</span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {devices.map((d) => {
        const Icon = DEVICE_ICON[d.device_type] ?? Cpu;
        const label = DEVICE_LABEL[d.device_type] ?? d.device_type;
        // connection_status chỉ có ý nghĩa với thiết bị kết nối qua agent
        // (scanner/printer/scale). Camera RTSP luôn 'unknown' trong DB nên ẩn.
        const showConn = d.device_type !== "camera" && !!d.connection_status;
        const online = d.connection_status === "online";
        const connText = d.connection_status
          ? CONN_STATUS_LABEL[d.connection_status] ?? d.connection_status
          : "";
        return (
          <span
            key={d.id}
            title={`${label} · ${d.name}${showConn ? ` · ${connText}` : ""}`}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-slate-100 text-slate-700 text-[11px] font-medium"
          >
            <Icon className="h-3 w-3 text-slate-500" />
            <span className="font-mono">{d.device_code}</span>
            {showConn && (
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  online ? "bg-emerald-500" : "bg-slate-300"
                }`}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

function StationDialog({
  mode,
  warehouses,
  initial,
  defaultWarehouseId,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  warehouses: WarehouseRef[];
  initial?: Station;
  defaultWarehouseId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    code: initial?.code ?? "",
    name: initial?.name ?? "",
    status: initial?.status ?? "active",
    warehouse_id: initial?.warehouse_id ?? defaultWarehouseId ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (mode === "create" && !form.warehouse_id) {
      setErr("Vui lòng chọn kho.");
      return;
    }
    setSaving(true);
    const url =
      mode === "create"
        ? "/api/packing-stations"
        : `/api/packing-stations/${initial!.id}`;
    const method = mode === "create" ? "POST" : "PATCH";
    const body: Record<string, unknown> = {
      code: form.code,
      name: form.name,
    };
    if (mode === "create") body.warehouse_id = form.warehouse_id;
    if (mode === "edit") body.status = form.status;

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
    <Modal
      title={mode === "create" ? "Thêm bàn đóng hàng" : `Sửa: ${initial?.name}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        {mode === "create" && (
          <Field label="Kho" required>
            <Select
              value={form.warehouse_id}
              onChange={(v) => setForm({ ...form, warehouse_id: v })}
              options={warehouses.map((w) => ({
                value: w.id,
                label: `${w.code} · ${w.name}`,
              }))}
              placeholder="Chọn kho..."
            />
          </Field>
        )}
        <Field label="Mã bàn" required hint="VD: BAN_01">
          <input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm font-mono uppercase"
          />
        </Field>
        <Field label="Tên bàn" required>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Bàn 01"
            className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm"
          />
        </Field>
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
