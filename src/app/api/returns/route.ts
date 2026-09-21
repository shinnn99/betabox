import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Danh sách kiện hàng hoàn cho trang Hàng hoàn.
 *
 * Sắp theo hạn xử lý gần nhất trước: việc cần làm gấp nằm trên đầu. Kiện
 * không có hồ sơ (kết quả OK) xếp sau, theo giờ quét mới nhất.
 *
 * Trả kèm lượt đóng đi cùng mã (nếu có) để giao diện phát hai video cạnh
 * nhau — đó là bằng chứng mạnh nhất khi khiếu nại tráo hàng.
 */

const RESULT_LABEL: Record<string, string> = {
  ok: "Hàng ổn",
  damaged: "Hỏng",
  missing: "Thiếu",
  swapped: "Tráo",
  unchecked: "Chưa kiểm",
};

interface ReturnRow {
  id: string;
  waybill_code: string | null;
  scanned_at: string;
  work_ended_at: string | null;
  work_duration_seconds: number | null;
  timing_status: string | null;
  return_kind: string | null;
  inspection_result: string | null;
  close_reason: string | null;
  status: string;
  station_id: string | null;
  staff_id: string | null;
  outbound_event_id: string | null;
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const url = req.nextUrl;
  const claimFilter = url.searchParams.get("claim_status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);

  const { data: events, error } = await admin
    .from("packing_events")
    .select(
      "id, waybill_code, scanned_at, work_ended_at, work_duration_seconds, timing_status, return_kind, inspection_result, close_reason, status, station_id, staff_id, outbound_event_id",
    )
    .eq("organization_id", ctx.organizationId)
    .eq("event_kind", "return")
    .in("status", ["valid", "return_suspect"])
    .order("scanned_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: "list_failed", message: error.message }, { status: 500 });
  }

  const rows = (events ?? []) as ReturnRow[];
  if (rows.length === 0) return NextResponse.json({ returns: [] });

  const eventIds = rows.map((r) => r.id);
  const outboundIds = rows.map((r) => r.outbound_event_id).filter((v): v is string => Boolean(v));
  const stationIds = [...new Set(rows.map((r) => r.station_id).filter((v): v is string => Boolean(v)))];
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((v): v is string => Boolean(v)))];

  const [claimsRes, clipsRes, outboundRes, stationsRes, staffRes] = await Promise.all([
    admin
      .from("return_claims")
      .select("id, packing_event_id, status, deadline_at, platform_claim_ref, note")
      .eq("organization_id", ctx.organizationId)
      .in("packing_event_id", eventIds),
    admin
      .from("order_proof_clips")
      .select("packing_event_id, status, updated_at")
      .in("packing_event_id", [...eventIds, ...outboundIds]),
    outboundIds.length
      ? admin
          .from("packing_events")
          .select("id, waybill_code, scanned_at, staff_id")
          .in("id", outboundIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    stationIds.length
      ? admin.from("packing_stations").select("id, code, name").in("id", stationIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    staffIds.length
      ? admin.from("staff_profiles").select("id, staff_code, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  const claimByEvent = new Map(
    (claimsRes.data ?? []).map((c) => [c.packing_event_id as string, c]),
  );
  const clipByEvent = new Map((clipsRes.data ?? []).map((c) => [c.packing_event_id as string, c]));
  const outboundById = new Map((outboundRes.data ?? []).map((o) => [o.id as string, o]));
  const stationById = new Map((stationsRes.data ?? []).map((s) => [s.id as string, s]));
  const staffById = new Map((staffRes.data ?? []).map((s) => [s.id as string, s]));

  const items = rows
    .map((row) => {
      const claim = claimByEvent.get(row.id) ?? null;
      const station = row.station_id ? stationById.get(row.station_id) : null;
      const staff = row.staff_id ? staffById.get(row.staff_id) : null;
      const outbound = row.outbound_event_id ? outboundById.get(row.outbound_event_id) : null;
      return {
        event_id: row.id,
        waybill_code: row.waybill_code,
        scanned_at: row.scanned_at,
        closed_at: row.work_ended_at,
        duration_seconds: row.work_duration_seconds,
        is_open: row.timing_status === "open",
        return_kind: row.return_kind,
        inspection_result: row.inspection_result,
        inspection_label: row.inspection_result ? RESULT_LABEL[row.inspection_result] ?? row.inspection_result : null,
        close_reason: row.close_reason,
        station: station ? { code: station.code as string, name: station.name as string } : null,
        staff: staff
          ? { staff_code: staff.staff_code as string, full_name: staff.full_name as string }
          : null,
        clip_status: (clipByEvent.get(row.id)?.status as string) ?? null,
        outbound: outbound
          ? {
              event_id: outbound.id as string,
              scanned_at: outbound.scanned_at as string,
              clip_status: (clipByEvent.get(outbound.id as string)?.status as string) ?? null,
            }
          : null,
        claim: claim
          ? {
              id: claim.id as string,
              status: claim.status as string,
              deadline_at: claim.deadline_at as string,
              platform_claim_ref: (claim.platform_claim_ref as string) ?? null,
              note: (claim.note as string) ?? null,
            }
          : null,
      };
    })
    .filter((item) => {
      if (!claimFilter || claimFilter === "all") return true;
      if (claimFilter === "none") return item.claim === null;
      return item.claim?.status === claimFilter;
    })
    .sort((a, b) => {
      // Hồ sơ còn mở lên đầu, hạn gần nhất trước.
      const aOpen = a.claim?.status === "open";
      const bOpen = b.claim?.status === "open";
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      if (aOpen && bOpen) {
        return Date.parse(a.claim!.deadline_at) - Date.parse(b.claim!.deadline_at);
      }
      return Date.parse(b.scanned_at) - Date.parse(a.scanned_at);
    });

  return NextResponse.json({ returns: items });
}
