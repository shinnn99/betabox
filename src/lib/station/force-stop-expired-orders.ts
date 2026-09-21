import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  AUTO_STOP_TIMING_NOTE,
  computeOrderTimeout,
  resolveOrderLimitSeconds,
  resolveReturnLimitSeconds,
} from "./order-timeout";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Cưỡng chế chốt các đơn đang mở quá trần thời gian.
 *
 * Trạng thái ghi vào DB dùng `timing_status='capped_timeout'` — giá trị
 * ĐÃ CÓ, không thêm enum mới, vì `clip-window.ts` nhánh capped_timeout
 * đã cắt clip theo `scanned_at + work_duration_seconds` thay vì theo
 * `work_ended_at`. Đó đúng là hành vi mình cần. Khác biệt duy nhất so
 * với capped_timeout do quét mã kế: `work_ended_at` ở đây là mốc hết
 * giờ (không có mã kế), nên ghi thêm `timing_note` để phân biệt khi
 * đối soát.
 *
 * Idempotent: update luôn kèm `.eq("timing_status", "open")`, hai tiến
 * trình cùng gọi (poll màn hình bàn + heartbeat agent) thì chỉ một cái
 * ăn row, cái còn lại update 0 row.
 */
export interface ForceStoppedOrder {
  id: string;
  station_id: string | null;
  waybill_code: string | null;
  /** Mốc bị chốt = work_started_at + limit_seconds. */
  work_ended_at: string;
  limit_seconds: number;
}

interface OpenOrderRow {
  id: string;
  station_id: string | null;
  warehouse_id: string | null;
  waybill_code: string | null;
  scanned_at: string;
  work_started_at: string | null;
  /** 'outbound' = đơn đi (trần max_order_seconds); 'return' = kiện hoàn (trần return_max_seconds). */
  event_kind: string | null;
}

/** Trần số đơn xử lý mỗi lượt — bàn bình thường chỉ có 0-1 đơn mở. */
const MAX_ORDERS_PER_SWEEP = 50;

export async function forceStopExpiredOrders(params: {
  admin: Admin;
  organizationId: string;
  /** Bỏ trống = quét toàn bộ bàn của tổ chức (dùng ở heartbeat agent). */
  stationId?: string;
  now?: Date;
}): Promise<ForceStoppedOrder[]> {
  const now = params.now ?? new Date();

  let query = params.admin
    .from("packing_events")
    .select("id, station_id, warehouse_id, waybill_code, scanned_at, work_started_at, event_kind")
    .eq("organization_id", params.organizationId)
    .eq("timing_status", "open")
    .is("work_ended_at", null)
    .order("scanned_at", { ascending: true })
    .limit(MAX_ORDERS_PER_SWEEP);
  if (params.stationId) query = query.eq("station_id", params.stationId);

  const { data: openRows, error: openError } = await query;
  if (openError) {
    console.warn(
      `[station-timeout] không đọc được đơn đang mở org=${params.organizationId} message=${openError.message}`,
    );
    return [];
  }
  const rows = (openRows ?? []) as OpenOrderRow[];
  if (rows.length === 0) return [];

  const warehouseIds = [
    ...new Set(rows.map((row) => row.warehouse_id).filter((id): id is string => Boolean(id))),
  ];
  const { data: warehouses } = warehouseIds.length
    ? await params.admin
        .from("warehouses")
        .select("id, packing_timing_config")
        .eq("organization_id", params.organizationId)
        .in("id", warehouseIds)
    : { data: [] };
  // Giữ nguyên config thay vì đã quy ra số giây: trần của đơn đi và của kiện
  // hoàn là hai khoá khác nhau trong cùng config.
  const configByWarehouse = new Map(
    (warehouses ?? []).map((warehouse) => [
      warehouse.id as string,
      warehouse.packing_timing_config as unknown,
    ]),
  );

  const stopped: ForceStoppedOrder[] = [];
  for (const row of rows) {
    const isReturn = row.event_kind === "return";
    const cfg = row.warehouse_id ? configByWarehouse.get(row.warehouse_id) ?? null : null;
    const limitSeconds = isReturn
      ? resolveReturnLimitSeconds(cfg)
      : resolveOrderLimitSeconds(cfg);
    const startedAt = row.work_started_at ?? row.scanned_at;
    const state = computeOrderTimeout({ startedAt, limitSeconds, now });
    if (!state.expired) continue;

    const workEndedAt = state.deadlineAt.toISOString();

    // Kiện hoàn đi qua RPC riêng: nó còn phải ghi kết quả "chưa kiểm" và
    // lý do đóng, và chính hai thứ đó mới kích hoạt hồ sơ khiếu nại.
    if (isReturn) {
      const { data: closed, error: closeError } = await params.admin.rpc("close_return_event", {
        p_event_id: row.id,
        p_result: "unchecked",
        p_close_reason: "timeout",
        p_at: workEndedAt,
      });
      if (closeError) {
        console.warn(
          `[station-timeout] chốt kiện hoàn thất bại pe=${row.id} message=${closeError.message}`,
        );
        continue;
      }
      if (closed === false) continue; // đường khác đã đóng trước
      console.warn(
        `[station-timeout] cưỡng chế dừng KIỆN HOÀN pe=${row.id} waybill=${row.waybill_code ?? "?"} limit=${limitSeconds}s`,
      );
      stopped.push({
        id: row.id,
        station_id: row.station_id,
        waybill_code: row.waybill_code,
        work_ended_at: workEndedAt,
        limit_seconds: limitSeconds,
      });
      continue;
    }

    const { data: updated, error: updateError } = await params.admin
      .from("packing_events")
      .update({
        timing_status: "capped_timeout",
        work_ended_at: workEndedAt,
        work_duration_seconds: limitSeconds,
        timing_note: AUTO_STOP_TIMING_NOTE,
      })
      .eq("id", row.id)
      .eq("organization_id", params.organizationId)
      .eq("timing_status", "open")
      .select("id")
      .maybeSingle();
    if (updateError) {
      console.warn(
        `[station-timeout] chốt đơn thất bại pe=${row.id} message=${updateError.message}`,
      );
      continue;
    }
    // Tiến trình khác đã chốt trước → không báo trùng.
    if (!updated) continue;

    console.warn(
      `[station-timeout] cưỡng chế dừng pe=${row.id} waybill=${row.waybill_code ?? "?"} limit=${limitSeconds}s ended_at=${workEndedAt}`,
    );
    stopped.push({
      id: row.id,
      station_id: row.station_id,
      waybill_code: row.waybill_code,
      work_ended_at: workEndedAt,
      limit_seconds: limitSeconds,
    });
  }

  return stopped;
}
