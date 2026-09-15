import { NextResponse } from "next/server";
import { requireStationLiveAccess } from "@/lib/live/station-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ stationId: string }>;
}

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function GET(_request: Request, context: RouteContext) {
  const { stationId } = await context.params;
  const access = await requireStationLiveAccess(stationId);
  if (access instanceof NextResponse) return access;

  const [sessionResult, packingResult] = await Promise.all([
    access.admin
      .from("staff_qr_scan_results")
      .select("id, action, warning_code, message, created_at, staff_profiles(staff_code, full_name)")
      .eq("organization_id", access.ctx.organizationId)
      .eq("station_id", stationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    access.admin
      .from("packing_events")
      .select("id, status, waybill_code, scanned_at")
      .eq("organization_id", access.ctx.organizationId)
      .eq("station_id", stationId)
      .order("scanned_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (sessionResult.error || packingResult.error) {
    return NextResponse.json(
      {
        error: "station_event_lookup_failed",
        message: sessionResult.error?.message ?? packingResult.error?.message,
      },
      { status: 500 },
    );
  }

  const session = sessionResult.data;
  const packing = packingResult.data;
  const sessionAt = session ? Date.parse(session.created_at) : Number.NEGATIVE_INFINITY;
  const packingAt = packing ? Date.parse(packing.scanned_at) : Number.NEGATIVE_INFINITY;
  if (!session && !packing) return NextResponse.json({ event: null });

  if (session && sessionAt >= packingAt) {
    const staff = pickOne(session.staff_profiles);
    const staffLabel = staff ? `${staff.staff_code} · ${staff.full_name}` : "Nhân viên";
    const success = !session.warning_code && [
      "checked_in",
      "checked_out",
      "switched_station",
      "replaced_staff",
    ].includes(session.action);
    const actionLabel = session.action === "checked_in"
      ? "mở ca"
      : session.action === "checked_out"
        ? "kết thúc ca"
        : session.action === "switched_station"
          ? "chuyển bàn"
          : session.action === "replaced_staff"
            ? "thay nhân viên"
            : "quét QR";
    return NextResponse.json({
      event: {
        id: `session:${session.id}`,
        occurred_at: session.created_at,
        level: success ? "success" : "error",
        message: success
          ? `Đã nhận · ${staffLabel} ${actionLabel}`
          : session.message ?? "QR nhân viên không hợp lệ",
      },
    });
  }

  const success = packing?.status === "valid";
  const message = success
    ? `Đã nhận · ${packing.waybill_code}`
    : packing?.status === "duplicated"
      ? `Mã đã quét · ${packing.waybill_code}`
      : packing?.status === "no_active_session"
        ? "Chưa mở ca"
        : "Không xử lý được mã quét";
  return NextResponse.json({
    event: {
      id: `packing:${packing?.id}`,
      occurred_at: packing?.scanned_at,
      level: success ? "success" : packing?.status === "duplicated" ? "warning" : "error",
      message,
    },
  });
}
