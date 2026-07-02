"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ScanLine, CheckCircle2, AlertTriangle } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";

interface Station {
  id: string;
  code: string;
  name: string;
  warehouse_id: string;
  status: string;
}

interface ScannerDevice {
  id: string;
  device_code: string;
  name: string;
  device_type: string;
  current_station: {
    station_id: string;
    station_code: string;
  } | null;
}

interface ScanResult {
  ok: boolean;
  duplicate: boolean;
  packing_result: {
    status: string;
    waybill_code: string | null;
    assignment_method: string;
  } | null;
  warning: { code: string; message: string } | null;
}

const STORAGE_KEY = "packing-scan:last";

/**
 * HID-keyboard / manual fallback for warehouses that don't run the local
 * agent (or where the scanner emulates a keyboard). The operator picks a
 * "virtual" scanner device + station up front; every Enter in the input
 * box becomes one waybill scan against /api/warehouse/manual-scan.
 *
 * Why we require selecting a scanner device first: the backend pipeline
 * resolves station via scanner_device_code → station_devices →
 * station_device_assignments. We don't bypass that — we just let the user
 * tell the page which scanner_device_code to stamp onto each scan.
 */
export default function ManualScanPage() {
  const toast = useToast();
  const [scanners, setScanners] = useState<ScannerDevice[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [scannerId, setScannerId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      raw: string;
      status: string;
      duplicate: boolean;
      warning: string | null;
      at: string;
    }>
  >([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restore previous device selection so a station running this page
  // doesn't have to repick every reload.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setScannerId(saved);
  }, []);

  useEffect(() => {
    if (scannerId) localStorage.setItem(STORAGE_KEY, scannerId);
  }, [scannerId]);

  const load = useCallback(async () => {
    setLoading(true);
    const [r1, r2] = await Promise.all([
      fetch("/api/station-devices?device_type=scanner", { cache: "no-store" }),
      fetch("/api/packing-stations", { cache: "no-store" }),
    ]);
    const d1 = await r1.json();
    const d2 = await r2.json();
    if (r1.ok) setScanners(d1.devices ?? []);
    if (r2.ok) setStations(d2.stations ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => scanners.find((s) => s.id === scannerId) ?? null,
    [scanners, scannerId],
  );
  const stationInfo = useMemo(() => {
    if (!selected?.current_station) return null;
    return stations.find((s) => s.id === selected.current_station!.station_id) ?? null;
  }, [selected, stations]);

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const value = input.trim();
    if (!value || !selected || submitting) return;
    setSubmitting(true);
    const agentEventId = crypto.randomUUID();
    const at = new Date();
    const res = await fetch("/api/warehouse/manual-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_event_id: agentEventId,
        scanner_device_code: selected.device_code,
        raw_value: value,
        scanned_at: at.toISOString(),
        source: "hid_keyboard",
      }),
    });
    const data = (await res.json()) as ScanResult & { error?: string; message?: string };
    setSubmitting(false);
    setInput("");
    inputRef.current?.focus();

    if (!res.ok) {
      toast.error(data.message ?? data.error ?? "Lưu scan thất bại");
      return;
    }

    const status = data.packing_result?.status ?? "unknown";
    setHistory((h) =>
      [
        {
          id: agentEventId,
          raw: value,
          status,
          duplicate: data.duplicate,
          warning: data.warning?.code ?? null,
          at: at.toLocaleTimeString("vi-VN"),
        },
        ...h,
      ].slice(0, 50),
    );

    if (data.warning) {
      toast.info(data.warning.message);
    } else if (status === "valid") {
      toast.success(`Đã ghi nhận ${data.packing_result?.waybill_code ?? value}`);
    } else if (status === "duplicated") {
      toast.info("Mã đã được quét trước đó trong cùng phiên.");
    } else if (status === "no_active_session") {
      toast.info(
        "Chưa có nhân viên check-in tại bàn này — quét mã nhân viên trước.",
      );
    } else if (status === "unmapped_scanner") {
      toast.error(
        `Scanner "${selected.device_code}" chưa được gán bàn. Gán bàn ở trang Thiết bị.`,
      );
    }
  };

  // Always keep focus on the input so a USB-HID scanner can type into it
  // without the operator clicking first. Browsers can steal focus on tab
  // switches; we refocus on any pointer-down outside an interactive control.
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest("input,button,select,a,textarea,[role=combobox]")) return;
      inputRef.current?.focus();
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, []);

  return (
    <DashboardLayout
      pageTitle="Quét tay / HID"
      pageSubtitle="Dùng khi không cài agent: scanner gõ vào ô bên dưới hoặc nhập tay."
      pageIcon={ScanLine}
    >
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Chọn máy quét
          </p>
          {loading ? (
            <p className="text-sm text-slate-400 inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải thiết bị...
            </p>
          ) : scanners.length === 0 ? (
            <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
              Chưa có thiết bị scanner nào. Tạo ở trang Thiết bị trước, rồi gán
              vào bàn.
            </p>
          ) : (
            <>
              <Select
                value={scannerId}
                onChange={(v) => setScannerId(v)}
                options={scanners.map((s) => ({
                  value: s.id,
                  label: `${s.device_code} — ${s.name}`,
                  hint: s.current_station
                    ? `Bàn ${s.current_station.station_code}`
                    : "Chưa gán bàn",
                }))}
                placeholder="Chọn scanner..."
              />
              {selected && (
                <p className="text-xs text-slate-500">
                  Scanner <span className="font-mono">{selected.device_code}</span>{" "}
                  {stationInfo ? (
                    <>
                      đang gán vào bàn{" "}
                      <span className="font-semibold text-emerald-700">
                        {stationInfo.code} — {stationInfo.name}
                      </span>
                    </>
                  ) : (
                    <span className="text-amber-700">
                      chưa gán bàn — scan sẽ bị mark `unmapped_scanner`.
                    </span>
                  )}
                </p>
              )}
            </>
          )}
        </div>

        <form
          onSubmit={submit}
          className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3"
        >
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Quét mã vận đơn
          </label>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!selected || submitting}
            placeholder="Nhấp con trỏ vào đây rồi quét..."
            className="w-full h-14 px-4 rounded-xl border-2 border-emerald-200 focus:border-emerald-400 outline-none text-lg font-mono uppercase disabled:bg-slate-50 disabled:text-slate-400"
          />
          <p className="text-xs text-slate-500">
            Quét xong scanner sẽ tự gửi Enter — không cần nhấn nút. Nhập tay thì
            gõ rồi nhấn Enter.
          </p>
          {submitting && (
            <p className="text-xs text-slate-400 inline-flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Đang gửi...
            </p>
          )}
        </form>

        {history.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <div className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-100">
              Lịch sử quét gần đây
            </div>
            <ul className="divide-y divide-slate-100">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="px-4 py-2.5 text-sm flex items-center gap-3"
                >
                  <span className="font-mono w-16 text-xs text-slate-500">
                    {h.at}
                  </span>
                  <span className="font-mono flex-1 truncate">{h.raw}</span>
                  {h.warning ? (
                    <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-0.5 rounded text-xs font-semibold">
                      <AlertTriangle className="h-3 w-3" />
                      {h.warning}
                    </span>
                  ) : h.status === "valid" ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded text-xs font-semibold">
                      <CheckCircle2 className="h-3 w-3" />
                      {h.duplicate ? "valid (dup)" : "valid"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-700 bg-slate-100 px-2 py-0.5 rounded text-xs font-semibold">
                      {h.status}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
