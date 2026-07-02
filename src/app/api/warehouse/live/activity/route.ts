import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ActivityKind =
  | "session_started"
  | "session_ended"
  | "session_forced_ended"
  | "waybill_valid"
  | "waybill_duplicated"
  | "waybill_no_session"
  | "waybill_unmapped"
  | "waybill_invalid"
  | "qr_invalid";

type ActivityCategory = "ok" | "warning" | "error" | "info";

interface ActivityItem {
  id: string;
  raw_event_id: string;
  kind: ActivityKind;
  category: ActivityCategory;
  occurred_at: string;
  scanner_device_code: string | null;
  station_code: string | null;
  station_name: string | null;
  warehouse_code: string | null;
  staff_code: string | null;
  staff_name: string | null;
  waybill_code: string | null;
  note: string | null;
  // Phase 8 timing
  work_started_at: string | null;
  work_ended_at: string | null;
  work_duration_seconds: number | null;
  timing_status: string | null;
}

function parseLimit(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("limit");
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const limit = parseLimit(req);
  const orgId = ctx.organizationId;

  const { data: raws, error: rawErr } = await admin
    .from("warehouse_scan_raw_events")
    .select(
      "id, scanner_device_code, raw_value, scan_type, scanned_at, received_at",
    )
    .eq("organization_id", orgId)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (rawErr) {
    return NextResponse.json({ error: rawErr.message }, { status: 500 });
  }

  const rawIds = (raws ?? []).map((r) => r.id);
  if (rawIds.length === 0) {
    return NextResponse.json({ activity: [] });
  }

  const [scanResults, packings] = await Promise.all([
    admin
      .from("staff_qr_scan_results")
      .select(
        `raw_event_id, action, warning_code, message,
         staff_profiles ( staff_code, full_name ),
         packing_stations ( code, name ),
         warehouses ( code )`,
      )
      .in("raw_event_id", rawIds),
    admin
      .from("packing_events")
      .select(
        `raw_event_id, status, assignment_method, waybill_code, previous_event_id,
         work_started_at, work_ended_at, work_duration_seconds, timing_status,
         staff_profiles ( staff_code, full_name ),
         packing_stations ( code, name ),
         warehouses ( code )`,
      )
      .in("raw_event_id", rawIds),
  ]);

  type ScanResultRow = NonNullable<typeof scanResults.data>[number];
  type PackingRow = NonNullable<typeof packings.data>[number];

  const scanByRaw = new Map<string, ScanResultRow>();
  for (const r of scanResults.data ?? []) scanByRaw.set(r.raw_event_id, r);
  const packByRaw = new Map<string, PackingRow>();
  for (const p of packings.data ?? []) packByRaw.set(p.raw_event_id, p);

  function pickOne<T>(v: T | T[] | null | undefined): T | null {
    if (!v) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }

  // Fallback: for raw events that have NO downstream record yet (waybill
  // scans processed before timing existed, or staff QR scans that never
  // produced a scan_result), still resolve station via resolve_scanner_at
  // so the table can show which table the scan happened at. This avoids
  // the misleading "Mã chưa được xử lý" + dash-only rows.
  const orphanRaws = (raws ?? []).filter(
    (r) => !packByRaw.has(r.id) && !scanByRaw.has(r.id),
  );
  const orphanResolved = new Map<
    string,
    { station_code: string; station_name: string; warehouse_code: string }
  >();
  if (orphanRaws.length > 0) {
    const results = await Promise.all(
      orphanRaws.map(async (r) => {
        const { data } = await admin
          .rpc("resolve_scanner_at", {
            p_organization_id: orgId,
            p_device_code: r.scanner_device_code,
            p_at: r.scanned_at,
          })
          .maybeSingle<{ station_id: string }>();
        return { rawId: r.id, stationId: data?.station_id ?? null };
      }),
    );
    const stationIds = Array.from(
      new Set(
        results.map((x) => x.stationId).filter((x): x is string => !!x),
      ),
    );
    if (stationIds.length > 0) {
      const { data: stations } = await admin
        .from("packing_stations")
        .select("id, code, name, warehouses ( code )")
        .in("id", stationIds);
      const byId = new Map<
        string,
        { code: string; name: string; warehouse_code: string }
      >();
      for (const s of stations ?? []) {
        const wh = pickOne(s.warehouses);
        byId.set(s.id, {
          code: s.code,
          name: s.name,
          warehouse_code: wh?.code ?? "",
        });
      }
      for (const r of results) {
        if (!r.stationId) continue;
        const meta = byId.get(r.stationId);
        if (meta) {
          orphanResolved.set(r.rawId, {
            station_code: meta.code,
            station_name: meta.name,
            warehouse_code: meta.warehouse_code,
          });
        }
      }
    }
  }

  const activity: ActivityItem[] = (raws ?? []).map((r) => {
    const isStaff = r.scan_type === "staff_qr";
    const sr = scanByRaw.get(r.id);
    const pe = packByRaw.get(r.id);

    let kind: ActivityKind = "waybill_invalid";
    let category: ActivityCategory = "info";
    let note: string | null = null;
    let staff: { staff_code: string; full_name: string } | null = null;
    let station: { code: string; name: string } | null = null;
    let warehouseCode: string | null = null;
    let waybill: string | null = null;
    let workStartedAt: string | null = null;
    let workEndedAt: string | null = null;
    let workDuration: number | null = null;
    let timingStatus: string | null = null;

    if (isStaff && sr) {
      staff = pickOne(sr.staff_profiles);
      station = pickOne(sr.packing_stations);
      warehouseCode = pickOne(sr.warehouses)?.code ?? null;
      if (sr.warning_code) {
        kind = "qr_invalid";
        category = "error";
        note = sr.message ?? "QR nhân sự không hợp lệ";
      } else if (sr.action === "checked_in") {
        kind = "session_started";
        category = "ok";
        note = "Bắt đầu ca";
      } else if (sr.action === "checked_out") {
        kind = "session_ended";
        category = "ok";
        note = "Kết thúc ca";
      } else if (sr.action === "switched_station") {
        kind = "session_forced_ended";
        category = "warning";
        note = "Chuyển bàn (phiên cũ bị đóng)";
      } else if (sr.action === "replaced_staff") {
        kind = "session_forced_ended";
        category = "warning";
        note = "Thay người tại bàn";
      } else {
        kind = "qr_invalid";
        category = "info";
        note = sr.message ?? null;
      }
    } else if (!isStaff && pe) {
      staff = pickOne(pe.staff_profiles);
      station = pickOne(pe.packing_stations);
      warehouseCode = pickOne(pe.warehouses)?.code ?? null;
      waybill = pe.waybill_code;
      workStartedAt = pe.work_started_at;
      workEndedAt = pe.work_ended_at;
      workDuration = pe.work_duration_seconds;
      timingStatus = pe.timing_status;
      if (pe.status === "valid") {
        kind = "waybill_valid";
        category = "ok";
        note =
          pe.assignment_method === "fallback_recent_session"
            ? "Gán theo ca vừa kết thúc"
            : null;
      } else if (pe.status === "duplicated") {
        kind = "waybill_duplicated";
        category = "warning";
        note = "Đã được quét trước đó";
      } else if (pe.status === "no_active_session") {
        kind = "waybill_no_session";
        category = "error";
        note = "Quét khi chưa có người vào ca";
      } else if (pe.status === "unmapped_scanner") {
        kind = "waybill_unmapped";
        category = "error";
        note = "Máy quét chưa gán bàn";
      } else {
        kind = "waybill_invalid";
        category = "error";
        note = "Mã không hợp lệ";
      }
    } else {
      // Orphan raw event (no downstream record). Use scanner→station
      // resolver so the table at least shows where it happened.
      const orphan = orphanResolved.get(r.id);
      if (orphan) {
        station = { code: orphan.station_code, name: orphan.station_name };
        warehouseCode = orphan.warehouse_code;
      }
      if (isStaff) {
        kind = "qr_invalid";
        category = "info";
        note = "QR nhân sự chưa được xử lý";
      } else {
        kind = "waybill_invalid";
        category = "info";
        note = "Đang chờ xử lý";
        waybill = r.raw_value;
      }
    }

    return {
      id: r.id,
      raw_event_id: r.id,
      kind,
      category,
      occurred_at: r.received_at,
      scanner_device_code: r.scanner_device_code,
      station_code: station?.code ?? null,
      station_name: station?.name ?? null,
      warehouse_code: warehouseCode,
      staff_code: staff?.staff_code ?? null,
      staff_name: staff?.full_name ?? null,
      waybill_code: waybill ?? (isStaff ? null : r.raw_value),
      note,
      work_started_at: workStartedAt,
      work_ended_at: workEndedAt,
      work_duration_seconds: workDuration,
      timing_status: timingStatus,
    };
  });

  return NextResponse.json({ activity });
}
