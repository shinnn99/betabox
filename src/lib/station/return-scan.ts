import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import type { StationMode } from "@/lib/station/station-mode";

type Admin = ReturnType<typeof createAdminClient>;

export type ReturnScanStatus =
  | "valid"
  | "duplicated_return"
  | "no_active_session"
  | "unmapped_scanner"
  | "invalid_code";

export interface ReturnScanResult {
  status: ReturnScanStatus;
  packing_event_id: string | null;
  waybill_code: string | null;
  station_id: string | null;
  return_kind: "rts" | "customer_return" | "suspect" | null;
  outbound_event_id: string | null;
  outbound_scanned_at: string | null;
  closed_previous_id: string | null;
}

export type InspectionResult = "ok" | "damaged" | "missing" | "swapped" | "unchecked";

/**
 * Chế độ hiện tại của bàn, hỏi nhanh bằng một RPC.
 *
 * Đường quét chạy ở mọi lượt nên phải rẻ; chỗ nào cần cả mốc bắt đầu kỳ thì
 * dùng `readStationMode` của station-mode.ts.
 */
export async function currentStationMode(
  admin: Admin,
  stationId: string,
): Promise<StationMode> {
  const { data, error } = await admin.rpc("station_current_mode", {
    p_station_id: stationId,
  });
  if (error) {
    console.warn(`[return-scan] không đọc được chế độ bàn ${stationId}: ${error.message}`);
    // Không đọc được chế độ thì coi như bàn đóng hàng: đó là đường cũ, và
    // lưới an toàn vẫn chặn kiện hoàn bị đếm thành đơn.
    return "outbound";
  }
  return data === "return" ? "return" : "outbound";
}

/** Mã vận đơn quét ở bàn đang ở chế độ NHẬN HOÀN. */
export async function processReturnScan(
  admin: Admin,
  rawEventId: string,
): Promise<ReturnScanResult | null> {
  const { data, error } = await admin
    .rpc("process_return_scan", { p_raw_event_id: rawEventId })
    .maybeSingle<ReturnScanResult>();
  if (error) {
    console.error(`[return-scan] process_return_scan lỗi raw=${rawEventId}: ${error.message}`);
    return null;
  }
  return data ?? null;
}

export interface CloseReturnOutcome {
  closed: boolean;
  event_id: string | null;
  waybill_code: string | null;
  result: InspectionResult | null;
}

