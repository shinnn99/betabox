import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { vietnamTodayUtcRange } from "@/lib/warehouse/time-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

type IssueKind =
  | "no_active_session"
  | "unmapped_scanner"
  | "duplicated"
  | "invalid_code"
  | "qr_invalid";

interface Issue {
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

function parseLimit(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("limit");
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Today's actionable issues — anything a manager should look at.
 *  - packing_events with non-valid status
 *  - staff_qr_scan_results with warning_code
 */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const limit = parseLimit(req);
  const orgId = ctx.organizationId;
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
      .in("status", ["duplicated", "no_active_session", "unmapped_scanner", "invalid_code"])
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

  function pickOne<T>(v: T | T[] | null | undefined): T | null {
    if (!v) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }

  const issues: Issue[] = [];

  for (const p of packingIssues.data ?? []) {
    const staff = pickOne(p.staff_profiles);
    const station = pickOne(p.packing_stations);
    let title = "Cảnh báo đơn";
    let message = "";
    if (p.status === "duplicated") {
      title = "Đơn quét trùng";
      message = `${p.waybill_code} đã được quét trước đó`;
    } else if (p.status === "no_active_session") {
      title = "Quét khi chưa vào ca";
      message = `${p.waybill_code} quét tại ${station?.name ?? p.scanner_device_code} khi không có ai trực`;
    } else if (p.status === "unmapped_scanner") {
      title = "Máy quét chưa gán bàn";
      message = `${p.scanner_device_code} chưa được gán vào bàn`;
    } else {
      title = "Mã không hợp lệ";
      message = p.waybill_code ?? "Mã rỗng";
    }
    issues.push({
      id: p.id,
      kind: p.status as IssueKind,
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
  return NextResponse.json({ issues: issues.slice(0, limit) });
}
