import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import {
  openReturnCapture,
  readCaptureStatus,
  releaseReturnCapture,
  touchReturnCapture,
} from "@/lib/station/return-capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tín hiệu bật/tắt phiên ghi hoàn từ trang Hàng hoàn.
 *
 * Ba hành động, cùng một đường:
 *   open      — người dùng chọn bàn và bắt đầu nhận hoàn;
 *   heartbeat — nhịp 30 giây, để cloud biết trình duyệt còn sống;
 *   close     — rời trang (kể cả sendBeacon lúc đóng tab).
 *
 * Người giữ phiên là `module:<user_id>` chứ không phải theo tab: hai tab
 * của cùng một người là một nguồn, đóng tab này không cắt ngang tab kia.
 *
 * Kế hoạch: plans/active/HOAN-HANG-phien-ghi-theo-module.md
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Action = "open" | "heartbeat" | "close";

export async function POST(req: NextRequest) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;

  let body: { station_id?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // sendBeacon gửi Blob; nếu không parse được thì coi như body rỗng.
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const stationId = typeof body.station_id === "string" ? body.station_id.trim() : "";
  if (!UUID_RE.test(stationId)) {
    return NextResponse.json({ error: "station_id_invalid" }, { status: 400 });
  }
  const action = body.action as Action;
  if (action !== "open" && action !== "heartbeat" && action !== "close") {
    return NextResponse.json({ error: "action_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Bàn phải thuộc tổ chức của người gọi. Không tin station_id từ body.
  const { data: station, error: stationErr } = await admin
    .from("packing_stations")
    .select("id, code, name, organization_id")
    .eq("id", stationId)
    .maybeSingle();
  if (stationErr) {
    return NextResponse.json({ error: "station_lookup_failed" }, { status: 500 });
  }
  if (!station || station.organization_id !== ctx.organizationId) {
    return NextResponse.json({ error: "station_not_found" }, { status: 404 });
  }

  const holder = `module:${ctx.userId}`;

  try {
    if (action === "open") {
      const result = await openReturnCapture({
        admin,
        organizationId: ctx.organizationId,
        stationId,
        holder,
      });
      const status = await readCaptureStatus({ admin, stationId });
      return NextResponse.json({
        ok: true,
        capture_id: result.captureId,
        camera_count: result.cameraIds.length,
        agent_notified: result.agentNotified,
        state: status?.state ?? "none",
        agent_acked: status?.agentAcked ?? false,
      });
    }

    if (action === "heartbeat") {
      const captureId = await touchReturnCapture({ admin, stationId, holder });
      const status = await readCaptureStatus({ admin, stationId });
      return NextResponse.json({
        ok: captureId !== null,
        // null = phiên đã đóng ở nơi khác (thẻ ĐÓNG HÀNG, đóng ca, hết
        // nhịp). Giao diện phải mở lại chứ không gia hạn ngầm.
        capture_id: captureId,
        state: status?.state ?? "none",
        agent_acked: status?.agentAcked ?? false,
      });
    }

    const released = await releaseReturnCapture({
      admin,
      organizationId: ctx.organizationId,
      stationId,
      holder,
      reason: "module_exit",
    });
    const status = await readCaptureStatus({ admin, stationId });
    return NextResponse.json({
      ok: true,
      capture_id: released.captureId,
      still_held: released.stillHeld,
      state: status?.state ?? "none",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[returns/capture] ${action} lỗi station=${stationId}: ${message}`);
    return NextResponse.json({ error: "capture_failed", message }, { status: 500 });
  }
}

/** Trạng thái phiên của một bàn — giao diện hỏi lúc tải trang. */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const stationId = req.nextUrl.searchParams.get("station_id") ?? "";

  // Không nêu bàn = hỏi danh sách bàn để chọn. Trả ở đây chứ không bắt
  // trang Hàng hoàn gọi /api/packing-stations: quyền của hai trang khác
  // nhau, người xem hàng hoàn không nhất thiết có quyền xem thiết bị kho.
  if (!stationId) {
    const { data: stations, error } = await admin
      .from("packing_stations")
      .select("id, code, name, purpose, status")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "active")
      .order("code");
    if (error) {
      return NextResponse.json({ error: "stations_failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, stations: stations ?? [] });
  }

  if (!UUID_RE.test(stationId)) {
    return NextResponse.json({ error: "station_id_invalid" }, { status: 400 });
  }

  const { data: station } = await admin
    .from("packing_stations")
    .select("id, organization_id")
    .eq("id", stationId)
    .maybeSingle();
  if (!station || station.organization_id !== ctx.organizationId) {
    return NextResponse.json({ error: "station_not_found" }, { status: 404 });
  }

  const status = await readCaptureStatus({ admin, stationId });
  const holder = `module:${ctx.userId}`;
  return NextResponse.json({
    ok: true,
    state: status?.state ?? "none",
    capture_id: status?.captureId ?? null,
    // Kỳ đã đóng thì dù state là gì cũng không còn giữ.
    held_by_me: status !== null && status.endedAt === null && status.holders.includes(holder),
    holder_count: status?.endedAt === null ? (status?.holders.length ?? 0) : 0,
    agent_acked: status?.agentAcked ?? false,
  });
}
