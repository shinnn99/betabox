import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type StationMode = "outbound" | "return";

export interface StationModeState {
  mode: StationMode;
  /** Kỳ chế độ đang mở; null = bàn chưa từng đổi chế độ (đang ở mặc định). */
  period_id: string | null;
  since: string | null;
  started_by: string | null;
}

function asMode(value: unknown): StationMode {
  return value === "return" ? "return" : "outbound";
}

/**
 * Chế độ hiện tại của một bàn.
 *
 * Chưa có kỳ nào thì chế độ là `purpose` của bàn. Đọc ở cloud thay vì gọi
 * RPC `station_current_mode` để lấy luôn mốc bắt đầu — màn hình bàn cần mốc
 * đó cho thông báo "vừa chuyển chế độ".
 */
export async function readStationMode(params: {
  admin: Admin;
  organizationId: string;
  stationId: string;
}): Promise<StationModeState> {
  const [{ data: period }, { data: station }] = await Promise.all([
    params.admin
      .from("station_mode_periods")
      .select("id, mode, started_at, started_by")
      .eq("organization_id", params.organizationId)
      .eq("station_id", params.stationId)
      .is("ended_at", null)
      .maybeSingle(),
    params.admin
      .from("packing_stations")
      .select("purpose")
      .eq("organization_id", params.organizationId)
      .eq("id", params.stationId)
      .maybeSingle(),
  ]);

  if (period) {
    return {
      mode: asMode(period.mode),
      period_id: period.id as string,
      since: period.started_at as string,
      started_by: (period.started_by as string) ?? null,
    };
  }
  return {
    mode: asMode(station?.purpose),
    period_id: null,
    since: null,
    started_by: null,
  };
}

export interface RevertedStation {
  station_id: string;
  station_code: string;
  idle_seconds: number;
}

/**
 * Lối ra tự động của chế độ NHẬN HOÀN: quá `return_idle_revert_seconds`
 * (mặc định 5 phút) không thao tác thì bàn tự về chế độ mặc định.
 *
 * Vì sao chạy ở cả màn hình bàn lẫn heartbeat agent: màn hình có thể bị tắt
 * và agent có thể mất mạng; hai nhịp độc lập nên luôn còn ít nhất một đường
 * đưa bàn về chế độ đóng hàng. Quên chuyển thẻ mà bàn kẹt ở chế độ hoàn
 * nghĩa là đơn đi của nhân viên không được đếm.
 *
 * Lỗi ở đây không bao giờ được chặn lượt poll hay heartbeat: trả mảng rỗng.
 */
export async function revertIdleReturnModes(params: {
  admin: Admin;
  organizationId: string;
  now?: Date;
}): Promise<RevertedStation[]> {
  const { data, error } = await params.admin.rpc("revert_idle_return_modes", {
    p_organization_id: params.organizationId,
    p_now: (params.now ?? new Date()).toISOString(),
  });
  if (error) {
    console.warn(
      `[station-mode] revert_idle_return_modes lỗi org=${params.organizationId}: ${error.message}`,
    );
    return [];
  }
  const rows = (data ?? []) as RevertedStation[];
  for (const row of rows) {
    console.warn(
      `[station-mode] ${row.station_code} tự về chế độ đóng hàng sau ${row.idle_seconds}s không thao tác`,
    );
  }
  return rows;
}
