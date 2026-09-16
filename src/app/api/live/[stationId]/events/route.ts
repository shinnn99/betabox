import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/admin";
import { requireStationLiveAccess } from "@/lib/live/station-access";
import {
  buildAutoStopAnnouncement,
  buildPackingScanAnnouncement,
  buildRecordingGapAnnouncement,
  buildStaffSessionAnnouncement,
  type StationAnnouncement,
} from "@/lib/station/announcements";
import { forceStopExpiredOrders } from "@/lib/station/force-stop-expired-orders";
import {
  AUTO_STOP_TIMING_NOTE,
  computeOrderTimeout,
  resolveOrderLimitSeconds,
} from "@/lib/station/order-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ stationId: string }>;
}

type Admin = ReturnType<typeof createAdminClient>;

/** Shape của `station_devices` khi join từ `station_device_assignments`. */
interface AssignedDeviceRow {
  station_devices:
    | { status: string; config_json: Record<string, unknown> | null }
    | { status: string; config_json: Record<string, unknown> | null }[]
    | null;
}

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Nguồn sự kiện cho màn hình bàn (client poll 1.5s).
 *
 * Route này KHÔNG đọc bảng log sự kiện riêng — nó suy ra sự kiện mới
 * nhất từ trạng thái thật: lần quét QR nhân viên gần nhất, đơn gần nhất
 * và việc đơn đó có bị cưỡng chế dừng hay không. Làm vậy để không phải
 * duy trì thêm một bảng event dễ lệch với sự thật.
 *
 * Route cũng là nơi thực thi trần thời gian đóng đơn: mỗi lượt poll sẽ
 * chốt các đơn đã quá hạn. Heartbeat của agent gọi cùng hàm đó để luật
 * vẫn chạy khi không ai mở màn hình bàn.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { stationId } = await context.params;
  const access = await requireStationLiveAccess(stationId);
  if (access instanceof NextResponse) return access;

  // Thực thi trần thời gian TRƯỚC khi đọc trạng thái, để cùng một lượt
  // poll vừa chốt đơn vừa trả về thông báo "tự động dừng".
  await forceStopExpiredOrders({
    admin: access.admin,
    organizationId: access.ctx.organizationId,
    stationId,
  });

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
      .select(
        "id, status, waybill_code, scanned_at, work_started_at, work_ended_at, work_duration_seconds, timing_status, timing_note, warehouse_id",
      )
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
  const candidates: StationAnnouncement[] = [];

  if (session) {
    const staff = pickOne(session.staff_profiles);
    candidates.push(
      buildStaffSessionAnnouncement({
        id: session.id,
        action: session.action,
        warningCode: session.warning_code,
        message: session.message,
        createdAt: session.created_at,
        staffLabel: staff ? `${staff.staff_code} · ${staff.full_name}` : "Nhân viên",
      }),
    );
  }

  // Đơn đang mở: dùng cho đồng hồ đếm ngược và cảnh báo chưa ghi hình.
  let currentOrder: {
    id: string;
    waybill_code: string | null;
    scanned_at: string;
    deadline_at: string;
    limit_seconds: number;
    remaining_seconds: number;
    warning: boolean;
  } | null = null;

  if (packing) {
    candidates.push(
      buildPackingScanAnnouncement({
        id: packing.id,
        status: packing.status,
        waybillCode: packing.waybill_code,
        scannedAt: packing.scanned_at,
      }),
    );

    if (packing.timing_note === AUTO_STOP_TIMING_NOTE && packing.work_ended_at) {
      candidates.push(
        buildAutoStopAnnouncement({
          id: packing.id,
          waybillCode: packing.waybill_code,
          workEndedAt: packing.work_ended_at,
          limitSeconds: packing.work_duration_seconds ?? 0,
        }),
      );
    }

    if (packing.timing_status === "open" && !packing.work_ended_at) {
      const { data: warehouse } = packing.warehouse_id
        ? await access.admin
            .from("warehouses")
            .select("packing_timing_config")
            .eq("id", packing.warehouse_id)
            .eq("organization_id", access.ctx.organizationId)
            .maybeSingle()
        : { data: null };
      const limitSeconds = resolveOrderLimitSeconds(warehouse?.packing_timing_config ?? null);
      const state = computeOrderTimeout({
        startedAt: packing.work_started_at ?? packing.scanned_at,
        limitSeconds,
      });
      currentOrder = {
        id: packing.id,
        waybill_code: packing.waybill_code,
        scanned_at: packing.scanned_at,
        deadline_at: state.deadlineAt.toISOString(),
        limit_seconds: limitSeconds,
        remaining_seconds: state.remainingSeconds,
        warning: state.warning,
      };

      // Chỉ kiểm tra ghi hình khi đang có đơn mở — lúc đó mất ghi hình
      // mới thật sự là mất bằng chứng, và tránh thêm 2 query mỗi 1.5s
      // vào lúc bàn đang rảnh.
      const gap = await findRecordingGap({
        admin: access.admin,
        organizationId: access.ctx.organizationId,
        stationId,
      });
      if (gap) {
        candidates.push(
          buildRecordingGapAnnouncement({
            stationId,
            waybillCode: packing.waybill_code,
            since: packing.scanned_at,
          }),
        );
      }
    }
  }

  if (candidates.length === 0) {
    return NextResponse.json({ event: null, current_order: null });
  }

  const latest = candidates.reduce((best, item) =>
    Date.parse(item.occurred_at) >= Date.parse(best.occurred_at) ? item : best,
  );
  return NextResponse.json({ event: latest, current_order: currentOrder });
}

/**
 * True khi bàn có camera được gán nhưng không camera nào đang ở phiên
 * ghi hình. Không có camera nào được gán thì trả false — đó là bàn dùng
 * máy quét, không phải lỗi mất ghi hình.
 */
async function findRecordingGap(params: {
  admin: Admin;
  organizationId: string;
  stationId: string;
}): Promise<boolean> {
  const { data: assignments } = await params.admin
    .from("station_device_assignments")
    .select("station_devices!inner(status, config_json)")
    .eq("organization_id", params.organizationId)
    .eq("station_id", params.stationId)
    .is("unassigned_at", null);

  const cameraIds = new Set<string>();
  for (const row of (assignments ?? []) as AssignedDeviceRow[]) {
    const device = pickOne(row.station_devices);
    if (!device || device.status === "archived") continue;
    const rawCameraId = device.config_json?.camera_id;
    const cameraId = typeof rawCameraId === "string" ? rawCameraId : "";
    const role = device.config_json?.role;
    if (!cameraId || (role !== "proof_primary" && role !== "proof_qr")) continue;
    cameraIds.add(cameraId);
  }
  if (cameraIds.size === 0) return false;

  const { data: recording } = await params.admin
    .from("camera_recording_sessions")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("status", "recording")
    .in("camera_id", [...cameraIds])
    .limit(1);
  return (recording ?? []).length === 0;
}
