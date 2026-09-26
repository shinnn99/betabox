/**
 * Kế hoạch sửa thời gian đóng đơn bị ghi sai vì lượt quét tới MUỘN
 * (kho Đại Kim, 26/09/2026) — hàm thuần, dùng chung cho script và test.
 *
 * Luật: trong MỘT bàn, xếp đơn đi hợp lệ theo giờ quét. Đơn nào đang kết
 * thúc MUỘN hơn giờ bắt đầu của đơn kế tiếp (chồng lên nhau), hoặc có thời
 * lượng âm, thì kết thúc đúng lúc đơn kế tiếp được quét — y hệt điều
 * `process_waybill_scan` (migration 20260926140000) làm cho lượt quét mới.
 *
 * Đơn bị TỰ DỪNG ở trần (kết thúc TRƯỚC đơn kế) là đúng — không đụng.
 * Đơn cuối của bàn trong ngày: chỉ sửa khi thời lượng âm / kết thúc trước khi
 * bắt đầu — kết thúc ở bắt đầu + trần, đúng như việc tự dừng vẫn làm.
 *
 * @param {Array<{id:string, scanned_at:string, work_started_at:string|null, work_ended_at:string|null,
 *   work_duration_seconds:number|null, timing_status:string, closed_by_packing_event_id:string|null}>} events
 *   Đơn đi 'valid' của MỘT bàn trong MỘT ngày.
 * @param {number} maxOrderSeconds  `max_order_seconds` từ resolve_packing_timing của kho.
 * @returns {Array<{
 *   id: string,
 *   before: {work_ended_at: string|null, work_duration_seconds: number|null, timing_status: string, closed_by_packing_event_id: string|null},
 *   after: {work_ended_at: string, work_duration_seconds: number, timing_status: string, closed_by_packing_event_id: string|null, timing_note: string},
 * }>}
 */
export function planTimingRepair(events, maxOrderSeconds) {
  const sorted = [...events]
    .filter((e) => e.timing_status !== "not_applicable")
    .sort((a, b) => Date.parse(a.scanned_at) - Date.parse(b.scanned_at));
  const fixes = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const startMs = Date.parse(cur.work_started_at ?? cur.scanned_at);
    const nextMs = Date.parse(next.scanned_at);
    const endMs = cur.work_ended_at ? Date.parse(cur.work_ended_at) : null;
    const negative = typeof cur.work_duration_seconds === "number" && cur.work_duration_seconds < 0;
    const overlaps = endMs === null || endMs > nextMs;
    if (!negative && !overlaps) continue;
    const realSeconds = Math.round((nextMs - startMs) / 1000);
    const capped = realSeconds > maxOrderSeconds;
    fixes.push({
      id: cur.id,
      before: {
        work_ended_at: cur.work_ended_at,
        work_duration_seconds: cur.work_duration_seconds,
        timing_status: cur.timing_status,
        closed_by_packing_event_id: cur.closed_by_packing_event_id,
      },
      after: {
        work_ended_at: new Date(nextMs).toISOString(),
        work_duration_seconds: capped ? maxOrderSeconds : realSeconds,
        timing_status: capped ? "capped_timeout" : "finalized_by_next_scan",
        closed_by_packing_event_id: next.id,
        timing_note: "repaired_late_scan",
      },
    });
  }
  // Đơn CUỐI của bàn mà thời lượng âm / kết thúc trước khi bắt đầu: không có
  // đơn kế để lấy giờ → sửa đúng như việc tự dừng vẫn làm (bắt đầu + trần).
  const last = sorted[sorted.length - 1];
  if (last) {
    const startMs = Date.parse(last.work_started_at ?? last.scanned_at);
    const endMs = last.work_ended_at ? Date.parse(last.work_ended_at) : null;
    const broken =
      (typeof last.work_duration_seconds === "number" && last.work_duration_seconds < 0) ||
      (endMs !== null && endMs < startMs);
    if (broken) {
      fixes.push({
        id: last.id,
        before: {
          work_ended_at: last.work_ended_at,
          work_duration_seconds: last.work_duration_seconds,
          timing_status: last.timing_status,
          closed_by_packing_event_id: last.closed_by_packing_event_id,
        },
        after: {
          work_ended_at: new Date(startMs + maxOrderSeconds * 1000).toISOString(),
          work_duration_seconds: maxOrderSeconds,
          timing_status: "capped_timeout",
          closed_by_packing_event_id: null,
          timing_note: "repaired_late_scan",
        },
      });
    }
  }
  return fixes;
}
