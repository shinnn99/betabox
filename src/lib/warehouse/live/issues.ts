import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { vietnamTodayUtcRange } from "@/lib/warehouse/time-range";

type Admin = ReturnType<typeof createAdminClient>;

export const ISSUES_DEFAULT_LIMIT = 30;
export const ISSUES_MAX_LIMIT = 100;

export type IssueKind =
  | "no_active_session"
  | "unmapped_scanner"
  | "duplicated"
  | "invalid_code"
  | "qr_invalid"
  // Chỉ có ở luồng hoàn: lưới an toàn bắt mã đã gửi đi quay lại bàn đóng
  // hàng — xem src/lib/warehouse/live/returns.ts
  | "return_suspect";

export interface Issue {
  id: string;
  kind: IssueKind;
  title: string;
  message: string;
  occurred_at: string;
  scanner_device_code: string | null;
  station_code: string | null;
  station_name: string | null;
  staff_code: string | null;
  staff_name: string | null;
  waybill_code: string | null;
  raw_event_id: string;
}

export function parseIssuesLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : ISSUES_DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return ISSUES_DEFAULT_LIMIT;
  return Math.min(n, ISSUES_MAX_LIMIT);
}

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Những trạng thái lượt quét được coi là "việc cần xử lý" của mỗi luồng.
 *
 * Hai luồng dùng CHUNG một danh sách và CHUNG một bộ chữ (chủ dự án chốt
 * 23/09/2026: "bên kia dùng để làm gì thì bên hoàn hàng cũng dùng y như
 * thế"). Chỉ khác đúng hai chỗ bắt buộc: tên trạng thái quét trùng của kiện
 * hoàn là `duplicated_return`, và lưới an toàn `return_suspect` chỉ sinh ra
 * ở luồng hoàn.
 */
export const ISSUE_STATUSES = {
  outbound: ["duplicated", "no_active_session", "unmapped_scanner", "invalid_code"],
  return: [
    "duplicated_return",
    "no_active_session",
    "unmapped_scanner",
    "invalid_code",
    "return_suspect",
  ],
} as const;

/**
 * Một lượt quét hỏng đọc thành việc cần làm — nguồn duy nhất của cả hai
 * màn hình giám sát. Đổi chữ ở đây là đổi cho cả đóng hàng lẫn hoàn hàng.
 */
export function describeScanIssue(row: {
  status: string;
  waybill_code: string | null;
  scanner_device_code: string | null;
  station_name: string | null;
}): { kind: IssueKind; title: string; message: string } {
  const where = row.station_name ?? row.scanner_device_code ?? "máy quét chưa rõ";
  switch (row.status) {
    case "duplicated":
    case "duplicated_return":
      return {
        kind: "duplicated",
        title: "Đơn quét trùng",
        message: `${row.waybill_code} đã được quét trước đó`,
      };
    case "no_active_session":
      return {
        kind: "no_active_session",
        title: "Quét khi chưa vào ca",
        message: `${row.waybill_code} quét tại ${where} khi không có ai trực`,
      };
    case "unmapped_scanner":
      return {
        kind: "unmapped_scanner",
        title: "Máy quét chưa gán bàn",
        message: `${row.scanner_device_code} chưa được gán vào bàn`,
      };
    case "return_suspect":
      return {
        kind: "return_suspect",
        title: "Hàng hoàn",
        message: `${row.waybill_code} đã đóng gửi đi trước đó, quét lại ở ${where} — không tính đơn`,
      };
    default:
      return {
        kind: "invalid_code",
        title: "Mã không hợp lệ",
        message: row.waybill_code ?? "Mã rỗng",
      };
  }
}

/**
 * Today's actionable issues — anything a manager should look at.
 *  - packing_events with non-valid status
 *  - staff_qr_scan_results with warning_code
 */
export async function buildLiveIssues(
  admin: Admin,
  orgId: string,
  limit: number,
): Promise<{ issues: Issue[] }> {
  const { startIso, endIso } = vietnamTodayUtcRange();

  const [packingIssues, qrIssues] = await Promise.all([
    admin
      .from("packing_events")
      .select(
        `id, raw_event_id, status, waybill_code, scanned_at, scanner_device_code,
         staff_profiles ( staff_code, full_name ),
         packing_stations ( code, name )`,
      )
      .eq("organization_id", orgId)
      .eq("event_kind", "outbound")
      .in("status", ISSUE_STATUSES.outbound)
      .gte("scanned_at", startIso)
      .lt("scanned_at", endIso)
      .order("scanned_at", { ascending: false })
      .limit(limit),
    admin
      .from("staff_qr_scan_results")
      .select(
        `id, raw_event_id, warning_code, message, created_at,
         staff_profiles ( staff_code, full_name ),
         packing_stations ( code, name )`,
      )
      .eq("organization_id", orgId)
      .not("warning_code", "is", null)
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  const issues: Issue[] = [];

  for (const p of packingIssues.data ?? []) {
    const staff = pickOne(p.staff_profiles);
    const station = pickOne(p.packing_stations);
    const { kind, title, message } = describeScanIssue({
      status: p.status,
      waybill_code: p.waybill_code,
      scanner_device_code: p.scanner_device_code,
      station_name: station?.name ?? null,
    });
    issues.push({
      id: p.id,
      kind,
      title,
      message,
      occurred_at: p.scanned_at,
      scanner_device_code: p.scanner_device_code,
      station_code: station?.code ?? null,
      station_name: station?.name ?? null,
      staff_code: staff?.staff_code ?? null,
      staff_name: staff?.full_name ?? null,
      waybill_code: p.waybill_code,
      raw_event_id: p.raw_event_id,
    });
  }

  for (const q of qrIssues.data ?? []) {
    const staff = pickOne(q.staff_profiles);
    const station = pickOne(q.packing_stations);
    issues.push({
      id: q.id,
      kind: "qr_invalid",
      title: "QR nhân sự không hợp lệ",
      message: q.message ?? q.warning_code ?? "Không xác định",
      occurred_at: q.created_at,
      scanner_device_code: null,
      station_code: station?.code ?? null,
      station_name: station?.name ?? null,
      staff_code: staff?.staff_code ?? null,
      staff_name: staff?.full_name ?? null,
      waybill_code: null,
      raw_event_id: q.raw_event_id,
    });
  }

  issues.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  return { issues: issues.slice(0, limit) };
}
