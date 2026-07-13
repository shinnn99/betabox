import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyWarehouseIssue } from "./notify-warehouse-issue.ts";
import type { LarkEventType } from "./messages.ts";

// Fire-and-forget hook cho hot path warehouse/scans + warehouse/manual-scan.
//
// Hai lớp catch:
//   - try/catch NGOÀI: chống lỗi ĐỒNG BỘ (undefined field, parse fail...)
//     — nếu thiếu, một field undefined làm hỏng đường quét của nhân viên.
//   - .catch() TRÊN PROMISE: chống lỗi ASYNC (fetch fail, timeout, DB error).
//
// Không await, không throw ra caller. Route caller CHỈ cần `hookLarkNotifyScan(...)`
// — không cần try/catch/void ở caller.

const STATUS_TO_EVENT: Record<string, LarkEventType | null> = {
  valid: null, // Không bắn cho scan thành công.
  duplicated: "packing_issue_duplicated",
  no_active_session: "packing_issue_no_active_session",
  unmapped_scanner: "packing_issue_unmapped_scanner",
  invalid_code: "packing_issue_invalid_code",
};

export interface HookScanInput {
  admin: SupabaseClient;
  organizationId: string;
  packingResult: {
    status: string | null;
    warehouse_id: string | null;
    waybill_code: string | null;
  } | null;
  scannedAtIso: string;
}

/**
 * Fire-and-forget notify Lark. AN TOÀN gọi từ hot path — không throw đồng bộ,
 * không reject Promise ra ngoài (đều catch trong).
 */
export function hookLarkNotifyScan(input: HookScanInput): void {
  try {
    // Guard đồng bộ: thiếu dữ liệu tối thiểu → im lặng, không throw.
    const pr = input.packingResult;
    if (!pr || !pr.status || !pr.warehouse_id) return;

    const eventType = STATUS_TO_EVENT[pr.status];
    if (!eventType) return; // valid hoặc status ngoài whitelist → bỏ qua.

    // Không await — Promise chạy song song, không block response route.
    notifyWarehouseIssue({
      admin: input.admin,
      organizationId: input.organizationId,
      warehouseId: pr.warehouse_id,
      eventType,
      waybillCode: pr.waybill_code,
      scannedAtIso: input.scannedAtIso,
    }).catch((err) => {
      // Lớp async: fetch fail, DB error trong orchestrator. Chỉ log.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[lark-hook] async error: ${msg}`);
    });
  } catch (err) {
    // Lớp đồng bộ: undefined field, parse fail, bất kỳ throw nào trước khi
    // Promise được trả. Chỉ log — KHÔNG throw ra hot path.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lark-hook] sync error: ${msg}`);
  }
}
