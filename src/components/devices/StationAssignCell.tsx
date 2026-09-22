"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

/**
 * Ô "Bàn đang phục vụ" trong bảng thiết bị kho — chọn bàn ngay tại chỗ.
 *
 * Vì sao để thẳng trong bảng thay vì mở hộp thoại: lắp kho là việc gán
 * hàng loạt, mỗi lần mở/đóng hộp thoại là một lần mất dấu mình đang ở
 * dòng nào. Danh sách bàn lấy từ chính danh sách bàn đang hoạt động, nên
 * thêm bàn mới là nó tự có mặt ở đây.
 *
 * Camera đi qua hai nhịp: chọn bàn rồi chọn vị trí (toàn cảnh / quét QR).
 * Không đoán hộ vị trí — gán nhầm vai trò nghĩa là clip bằng chứng lấy
 * sai góc hình, mà lỗi đó chỉ lộ ra khi cần tới clip.
 *
 * Hai chỗ VA CHẠM đều phải hỏi trước, vì cả hai đều đẩy một camera đang
 * làm việc ra khỏi chỗ của nó:
 *   - bàn đã đủ hai camera;
 *   - vị trí định gắn đang có camera khác.
 * Máy chủ chỉ đẩy camera CÙNG vị trí, camera vị trí còn lại không bị
 * đụng tới — nhưng người bấm phải biết trước điều đó sắp xảy ra.
 */

export type CameraRole = "proof_primary" | "proof_qr";

export const ROLE_LABEL: Record<CameraRole, string> = {
  proof_primary: "Toàn cảnh",
  proof_qr: "Quét QR",
};

export interface AssignStation {
  id: string;
  code: string;
  name: string;
  /** Bàn nhận lượt quét từ súng hay từ camera ở vị trí QR. */
  scan_source?: "scanner" | "camera" | null;
}

/** Camera đang chiếm một vị trí ở một bàn. */
export interface StationOccupant {
  cameraId: string;
  cameraCode: string;
  stationId: string;
  role: CameraRole | null;
}

type Pending =
  | null
  | { stationId: string; step: "confirm-full" }
  | { stationId: string; step: "pick-role" }
  | { stationId: string; step: "confirm-evict"; role: CameraRole };

export default function StationAssignCell({
  deviceId,
  isCamera,
  cameraId,
  currentStation,
  currentRole,
  stations,
  occupants,
  onSaved,
  readOnly = false,
}: {
  /** `station_devices.id` — với camera là soft-link, không phải camera id. */
  deviceId: string | null;
  isCamera: boolean;
  cameraId?: string;
  currentStation: { station_id: string; station_code: string; station_name: string } | null;
  currentRole: CameraRole | null;
  stations: AssignStation[];
  /** Mọi camera đang gắn bàn, để biết chỗ nào đã có người. */
  occupants: StationOccupant[];
  onSaved: () => void;
  /** Không có quyền gán bàn (VD Trưởng kho): ô chọn không mở, bấm vào chỉ báo. */
  readOnly?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const disabled = busy || !deviceId;

  /** Camera khác đang ở bàn này (không tính chính nó). */
  const othersAt = (stationId: string) =>
    occupants.filter((o) => o.stationId === stationId && o.cameraId !== cameraId);

  const assign = async (stationId: string, role: CameraRole | null) => {
    if (!deviceId) return;
    setBusy(true);
    setErr(null);
    try {
      if (isCamera && role && cameraId) {
        const res = await fetch(`/api/station-devices/${deviceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config_json: { camera_id: cameraId, role } }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.message ?? j.error ?? "Không đặt được vị trí camera.");
        }
      }
      const res = await fetch("/api/station-device-assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, station_id: stationId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? "Gán bàn thất bại.");
      }
      const st = stations.find((s) => s.id === stationId);
      const evicted = role ? othersAt(stationId).find((o) => o.role === role) : undefined;
      toast.success(
        evicted
          ? `Đã gắn vào ${st?.code ?? "bàn"} · ${ROLE_LABEL[role!]}. ${evicted.cameraCode} bị đẩy ra, giờ chưa gắn bàn.`
          : role
            ? `Đã gắn ${ROLE_LABEL[role].toLowerCase()} vào ${st?.code ?? "bàn"}`
            : `Đã gán vào ${st?.code ?? "bàn"}`,
      );
      setPending(null);
      onSaved();
    } catch (assignError) {
      setErr((assignError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unassign = async () => {
    if (!deviceId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/station-device-assignments", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? "Bỏ gán thất bại.");
      }
      toast.success("Đã bỏ gán khỏi bàn.");
      setPending(null);
      onSaved();
    } catch (unassignError) {
      setErr((unassignError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onPickStation = (value: string) => {
    setErr(null);
    if (value === "") {
      void unassign();
      return;
    }
    if (!isCamera) {
      void assign(value, null);
      return;
    }
    // Bàn đã đủ hai camera → hỏi trước khi cho đi tiếp.
    if (othersAt(value).length >= 2) {
      setPending({ stationId: value, step: "confirm-full" });
      return;
    }
    setPending({ stationId: value, step: "pick-role" });
  };

  const onPickRole = (stationId: string, role: CameraRole) => {
    const taken = othersAt(stationId).find((o) => o.role === role);
    if (taken) {
      setPending({ stationId, step: "confirm-evict", role });
      return;
    }
    void assign(stationId, role);
  };

  const pendingStation = pending
    ? stations.find((s) => s.id === pending.stationId)
    : null;

  /**
   * Camera ở vị trí QR chỉ ĐỌC MÃ khi bàn đặt nguồn quét = camera; còn lại
   * nó chỉ ghi hình góc QR cho clip. Trước đây không có chỗ nào cho thấy
   * điều này — camera nhìn rõ mã mà không quét được, người dùng không biết
   * vì sao (gặp thật 18/09/2026 ở BAN_04).
   */
  const station = currentStation ? stations.find((s) => s.id === currentStation.station_id) : null;
  const readsQr = station?.scan_source === "camera";

  const setScanSource = async (next: "scanner" | "camera") => {
    if (!currentStation) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/packing-stations/${currentStation.station_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scan_source: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? "Không đổi được nguồn quét.");
      }
      toast.success(
        next === "camera"
          ? `${currentStation.station_code} giờ đọc mã bằng camera này. Súng quét ở bàn sẽ bị bỏ qua.`
          : `${currentStation.station_code} quay về đọc mã bằng súng quét. Camera này chỉ còn ghi hình.`,
      );
      onSaved();
    } catch (scanError) {
      setErr((scanError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <select
          value={pending?.stationId ?? currentStation?.station_id ?? ""}
          disabled={disabled}
          onChange={(e) => onPickStation(e.target.value)}
          onMouseDown={(e) => {
            if (!readOnly) return;
            e.preventDefault();
            toast.error("Bạn không có quyền đổi bàn cho thiết bị.");
          }}
          onKeyDown={(e) => {
            if (!readOnly) return;
            e.preventDefault();
            toast.error("Bạn không có quyền đổi bàn cho thiết bị.");
          }}
          className="h-7 max-w-[11rem] rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 outline-none disabled:bg-slate-50 focus:border-emerald-400"
          aria-label="Bàn đang phục vụ"
        >
          <option value="">Chưa gắn</option>
          {/* Người chỉ xem có thể không tải được danh sách bàn (không có quyền
              xem bàn) — vẫn phải hiện đúng bàn đang gắn, không rơi về "Chưa gắn". */}
          {currentStation && !stations.some((s) => s.id === currentStation.station_id) && (
            <option value={currentStation.station_id}>
              {currentStation.station_code} · {currentStation.station_name}
            </option>
          )}
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
      </div>

      {/* Cảnh báo 1 — bàn đã đủ hai camera */}
      {pending?.step === "confirm-full" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-1.5 space-y-1">
          <p className="flex items-start gap-1 text-[11px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              <b>{pendingStation?.code}</b> đã đủ 2 camera (
              {othersAt(pending.stationId)
                .map((o) => `${o.cameraCode}: ${o.role ? ROLE_LABEL[o.role] : "chưa đặt"}`)
                .join(", ")}
              ). Xác nhận đổi?
            </span>
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPending({ stationId: pending.stationId, step: "pick-role" })}
              className="h-6 px-2 rounded-md bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-semibold"
            >
              Xác nhận
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="h-6 px-2 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-800"
            >
              Huỷ
            </button>
          </div>
        </div>
      )}

      {/* Nhịp 2 — chọn vị trí */}
      {pending?.step === "pick-role" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-1.5">
          <p className="text-[10px] font-semibold text-emerald-800 mb-1">Chọn vị trí gắn</p>
          <div className="flex flex-wrap gap-1">
            {(["proof_primary", "proof_qr"] as CameraRole[]).map((r) => {
              const taken = othersAt(pending.stationId).find((o) => o.role === r);
              return (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => onPickRole(pending.stationId, r)}
                  title={taken ? `Đang là ${taken.cameraCode}` : "Vị trí còn trống"}
                  className={`h-6 px-2 rounded-md border text-[11px] font-semibold disabled:opacity-50 ${
                    taken
                      ? "bg-white border-amber-300 text-amber-800 hover:bg-amber-50"
                      : "bg-white border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                  }`}
                >
                  {ROLE_LABEL[r]}
                  {taken && <span className="font-normal"> · đã có</span>}
                </button>
              );
            })}
            <button
              type="button"
              disabled={busy}
              onClick={() => setPending(null)}
              className="h-6 px-2 rounded-md text-[11px] font-medium text-slate-500 hover:text-slate-700"
            >
              Huỷ
            </button>
          </div>
        </div>
      )}

      {/* Cảnh báo 2 — vị trí đó đang có camera khác */}
      {pending?.step === "confirm-evict" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-1.5 space-y-1">
          <p className="flex items-start gap-1 text-[11px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Vị trí <b>{ROLE_LABEL[pending.role]}</b> ở {pendingStation?.code} đang là{" "}
              <b>
                {othersAt(pending.stationId).find((o) => o.role === pending.role)?.cameraCode}
              </b>
              . Xác nhận đổi? Camera cũ sẽ bị đẩy ra và về trạng thái chưa gắn
              bàn; camera ở vị trí còn lại không bị ảnh hưởng.
            </span>
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void assign(pending.stationId, pending.role)}
              className="h-6 px-2 rounded-md bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-semibold disabled:opacity-50"
            >
              Xác nhận đổi
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPending({ stationId: pending.stationId, step: "pick-role" })}
              className="h-6 px-2 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-800"
            >
              Quay lại
            </button>
          </div>
        </div>
      )}

      {/* Kết quả hiện ngay trên bảng, không phải mở ra mới thấy. */}
      {!pending && currentStation && (
        <p className="text-[11px] text-slate-500">
          {currentStation.station_name}
          {isCamera &&
            (currentRole ? (
              <>
                {" · "}
                <span className="font-semibold text-slate-600">{ROLE_LABEL[currentRole]}</span>
              </>
            ) : (
              <span className="text-amber-600"> · chưa đặt vị trí</span>
            ))}
        </p>
      )}

      {isCamera && !pending && currentStation && currentRole === "proof_qr" && station && (
        <div
          className={`rounded-lg border p-1.5 space-y-1 ${
            readsQr ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"
          }`}
        >
          <p className={`text-[11px] ${readsQr ? "text-emerald-800" : "text-slate-600"}`}>
            {readsQr
              ? "Đang đọc mã QR cho bàn (súng quét ở bàn bị bỏ qua)."
              : "Chỉ ghi hình — bàn đang đọc mã bằng súng quét."}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (readOnly) {
                toast.error("Bạn không có quyền đổi nguồn quét của bàn.");
                return;
              }
              void setScanSource(readsQr ? "scanner" : "camera");
            }}
            className={`h-6 px-2 rounded-md text-[11px] font-semibold disabled:opacity-50 ${
              readsQr
                ? "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"
                : "bg-emerald-600 hover:bg-emerald-700 text-white"
            }`}
          >
            {readsQr ? "Chuyển về súng quét" : "Dùng camera này để quét mã"}
          </button>
        </div>
      )}

      {isCamera && !pending && currentStation && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (readOnly) {
              toast.error("Bạn không có quyền đổi vị trí camera.");
              return;
            }
            setPending({ stationId: currentStation.station_id, step: "pick-role" });
          }}
          className={`text-[11px] text-emerald-600 hover:text-emerald-700 underline underline-offset-2${readOnly ? " opacity-50 cursor-not-allowed" : ""}`}
        >
          Đổi vị trí
        </button>
      )}

      {err && <p className="text-[11px] text-rose-600">{err}</p>}
      {!deviceId && <p className="text-[11px] text-slate-400">Chưa có bản ghi thiết bị.</p>}
    </div>
  );
}
