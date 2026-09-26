import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * Đơn đi cùng mã, cùng ngày làm việc (giờ Việt Nam) — cho route quét quyết
 * định "mã trùng thì báo trùng, không lưu" (chủ dự án chốt 26/09/2026). Tách
 * khỏi route vì file route chỉ nên xuất handler. Đúng tiêu chí trùng
 * mà `process_waybill_scan` dùng: mã viết hoa đã cắt khoảng trắng, trạng
 * thái valid / duplicated, `event_kind = 'outbound'`.
 */
export async function findSameDayOutboundOrder(
  admin: ReturnType<typeof createAdminClient>,
  input: { organizationId: string; waybillCode: string; scannedAt: string },
): Promise<{ id: string; scanned_at: string } | null> {
  const { data, error } = await admin
    .from("packing_events")
    .select("id, scanned_at")
    .eq("organization_id", input.organizationId)
    .eq("waybill_code", input.waybillCode.trim().toUpperCase())
    .eq("business_date", vnBusinessDate(input.scannedAt))
    .eq("event_kind", "outbound")
    .in("status", ["valid", "duplicated"])
    .order("scanned_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  // Đọc lỗi thì coi như chưa có đơn → đi đường cũ (lưu kèm lý do). Thà lưu
  // thừa một dòng còn hơn nuốt mất một đơn thật.
  if (error || !data) return null;
  return data as { id: string; scanned_at: string };
}

/** Ngày làm việc theo giờ Việt Nam (UTC+7, không đổi giờ mùa). */
export function vnBusinessDate(iso: string): string {
  return new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function vnClock(iso: string): string {
  return new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(11, 19);
}
