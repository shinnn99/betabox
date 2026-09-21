import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { invalidateCameraCaches, listCameras } from "@/lib/camera/service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("packing_station.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") update.name = body.name.trim();
  if (typeof body.code === "string") update.code = body.code.trim().toUpperCase();
  if (typeof body.status === "string") update.status = body.status;
  // Nguồn tạo lượt quét của bàn: súng quét hay camera ở vị trí QR. Chỉ một
  // nguồn được nhận — lượt quét từ nguồn kia bị từ chối (scan_source_disabled).
  // Chế độ mặc định của bàn: bàn đóng hàng hay bàn chuyên nhận hoàn.
  // Trigger `packing_stations_apply_purpose` đổi chế độ đang chạy ngay.
  if (body.purpose !== undefined) {
    if (body.purpose !== "outbound" && body.purpose !== "return") {
      return NextResponse.json(
        { error: "invalid_purpose", message: "Chế độ bàn chỉ là 'outbound' hoặc 'return'." },
        { status: 400 },
      );
    }
    update.purpose = body.purpose;
  }
  if (body.scan_source !== undefined) {
    if (body.scan_source !== "scanner" && body.scan_source !== "camera") {
      return NextResponse.json(
        { error: "invalid_scan_source", message: "Nguồn quét chỉ là 'scanner' hoặc 'camera'." },
        { status: 400 },
      );
    }
    update.scan_source = body.scan_source;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("packing_stations")
    .update(update)
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (error) {
    const msg =
      (error as { code?: string }).code === "23505"
        ? "Mã bàn đã tồn tại trong kho này."
        : error.message;
    return NextResponse.json({ error: error.code ?? "update_failed", message: msg }, { status: 400 });
  }

  if (update.scan_source !== undefined) {
    // Đổi nguồn quét phải có hiệu lực NGAY: bật/gỡ máy quét ảo của camera
    // QR ở bàn này (ensureQrVirtualScanners chạy trong listCameras). Không
    // làm ở đây thì máy quét ảo nằm im tới lần kế có người mở trang thiết
    // bị — camera không đọc mã dù bàn đã chuyển sang quét bằng camera.
    invalidateCameraCaches(ctx.organizationId);
    try {
      await listCameras(ctx.organizationId);
    } catch (repairError) {
      console.warn(
        `[packing-stations] sua may quet ao sau khi doi nguon quet that bai station=${id}: ${(repairError as Error).message}`,
      );
    }
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "packing_station.update",
    targetType: "packing_station",
    targetId: id,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true });
}

/**
 * Archive (soft-delete) — we don't hard-delete stations because past
 * staff_work_sessions / packing_events reference them via FK. The dashboard
 * filters out archived rows where appropriate.
 */
export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("packing_station.archive");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();

  // Cross-tenant guard: verify station thuộc org trước mọi tác động
  // cascade. Nếu attacker gửi station_id org khác, refuse 404 SỚM —
  // không cascade sang staff_work_sessions/station_device_assignments
  // org khác. Update packing_stations dưới cũng có org filter (defense-
  // in-depth), nhưng verify trước tránh cascade oan.
  const { data: stationOwn } = await admin
    .from("packing_stations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (!stationOwn) {
    return NextResponse.json(
      { error: "not_found", message: "Không tìm thấy bàn." },
      { status: 404 },
    );
  }

  // Refuse if station has an active work session — operator should end it
  // first. Otherwise archiving silently breaks the live dashboard.
  const { count: activeSessions } = await admin
    .from("staff_work_sessions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", id)
    .eq("status", "active");
  if ((activeSessions ?? 0) > 0) {
    return NextResponse.json(
      {
        error: "station_in_use",
        message: "Bàn đang có phiên hoạt động, hãy kết thúc phiên trước khi lưu trữ.",
      },
      { status: 400 },
    );
  }

  // Close any active device assignment pointing at this station.
  // Business-critical: assignment vẫn active + station archived → sync sai.
  // Fail-fast: nếu assignment cascade close fail, return 500 KHÔNG tiến hành
  // archive station (giữ state atomic).
  const { error: assignErr } = await admin
    .from("station_device_assignments")
    .update({
      unassigned_at: new Date().toISOString(),
      status: "ended",
    })
    .eq("organization_id", ctx.organizationId)
    .eq("station_id", id)
    .is("unassigned_at", null);
  if (assignErr) {
    return NextResponse.json(
      { error: "assignment_close_failed", message: assignErr.message },
      { status: 500 },
    );
  }

  const { error } = await admin
    .from("packing_stations")
    .update({ status: "archived" })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Closed any active camera↔station assignment pointing at this
  // station above. Drop the camera service cache so the next list
  // reflects the cleared mapping.
  invalidateCameraCaches(ctx.organizationId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "packing_station.archive",
    targetType: "packing_station",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
