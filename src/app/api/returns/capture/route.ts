import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import {
  moduleHolder,
  openReturnCapture,
  readCaptureStatuses,
  releaseReturnCapture,
  touchReturnCapture,
  type StationCaptureStatus,
} from "@/lib/station/return-capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tín hiệu bật/tắt phiên nhận hoàn từ phân hệ Hàng hoàn.
 *
 * Ba hành động, cùng một đường:
 *   open      — bắt đầu nhận hoàn ở một hoặc nhiều bàn;
 *   heartbeat — nhịp 30 giây cho MỌI bàn tab này đang giữ, một request;
 *   close     — thôi nhận hoàn (kể cả sendBeacon lúc rời phân hệ).
 *
 * Đợt 6 (21/09/2026): mọi bàn nhận hoàn song song. Một lượt nhận nhiều bàn
 * (`station_ids`) để một màn hình bật được cả kho, và người giữ phiên tính
 * theo TAB (`tab_id`) để nhiều máy dùng chung tài khoản không tắt phiên của
 * nhau. Xem moduleHolder() ở src/lib/station/return-capture.ts.
 *
 * Mỗi bàn xử lý riêng và báo kết quả riêng: một bàn lỗi (bàn không có
 * camera, bàn vừa bị đổi) không được làm hỏng các bàn còn lại.
 *
 * Kế hoạch: plans/active/HOAN-HANG-song-song-moi-ban.md
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Trần số bàn mỗi lượt — đủ cho một kho, chặn request vô lý. */
const MAX_STATIONS = 50;

type Action = "open" | "heartbeat" | "close";

interface StationResult {
  station_id: string;
  ok: boolean;
  error?: string;
  capture_id?: string | null;
  camera_count?: number;
  agent_notified?: boolean;
  still_held?: boolean;
}

function statusView(status: StationCaptureStatus | undefined, holder: string) {
  return {
    state: status?.state ?? "none",
    held_by_me: Boolean(status?.open && status.holders.includes(holder)),
    holder_count: status?.open ? status.holders.length : 0,
    agent_acked: status?.agentAcked ?? false,
  };
}

export async function POST(req: NextRequest) {
  // Mở/đóng phiên nhận hoàn là THAO TÁC kho (ra lệnh cho agent) — Viewer
  // chỉ xem, nên không dùng quyền xem bằng chứng như GET.
  const ctx = await requirePermission("return.operate", req);
  if (isError(ctx)) return ctx;

  let body: {
    station_id?: unknown;
    station_ids?: unknown;
    action?: unknown;
    tab_id?: unknown;
    force?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const action = body.action as Action;
  if (action !== "open" && action !== "heartbeat" && action !== "close") {
    return NextResponse.json({ error: "action_invalid" }, { status: 400 });
  }

  const requested = Array.isArray(body.station_ids)
    ? body.station_ids
    : body.station_id !== undefined
      ? [body.station_id]
      : [];
  const stationIds = Array.from(
    new Set(
      requested.filter((v): v is string => typeof v === "string" && UUID_RE.test(v.trim())).map((v) => v.trim()),
    ),
  );
  if (stationIds.length === 0) {
    return NextResponse.json({ error: "station_id_invalid" }, { status: 400 });
  }
  if (stationIds.length > MAX_STATIONS) {
    return NextResponse.json({ error: "too_many_stations", max: MAX_STATIONS }, { status: 400 });
  }

  const admin = createAdminClient();

  // Bàn phải thuộc tổ chức của người gọi. Không tin station_id từ body.
  const { data: owned, error: ownedErr } = await admin
    .from("packing_stations")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .in("id", stationIds);
  if (ownedErr) {
    return NextResponse.json({ error: "station_lookup_failed" }, { status: 500 });
  }
  const ownedIds = new Set((owned ?? []).map((s) => s.id as string));

  const holder = moduleHolder(ctx.userId, body.tab_id);

  // Mỗi bàn chạy riêng, song song. Khoá ở database là theo TỪNG BÀN nên
  // các bàn không chờ nhau.
  const results: StationResult[] = await Promise.all(
    stationIds.map(async (stationId): Promise<StationResult> => {
      if (!ownedIds.has(stationId)) {
        return { station_id: stationId, ok: false, error: "station_not_found" };
      }
      try {
        if (action === "open") {
          const r = await openReturnCapture({
            admin,
            organizationId: ctx.organizationId,
            stationId,
            holder,
          });
          return {
            station_id: stationId,
            ok: r.captureId !== null,
            capture_id: r.captureId,
            camera_count: r.cameraIds.length,
            agent_notified: r.agentNotified,
          };
        }
        if (action === "heartbeat") {
          const captureId = await touchReturnCapture({ admin, stationId, holder });
          // null = phiên đã đóng ở nơi khác (thẻ ĐÓNG HÀNG, đóng ca, hết
          // nhịp). Giao diện phải mở lại chứ không gia hạn ngầm.
          return { station_id: stationId, ok: captureId !== null, capture_id: captureId };
        }
        const r = await releaseReturnCapture({
          admin,
          organizationId: ctx.organizationId,
          stationId,
          holder,
          reason: body.force ? "module_force_exit" : "module_exit",
          // Ép tắt: dùng khi bàn đang bật bởi một nguồn đã chết (tab đóng
          // đột ngột nên tên người giữ kẹt lại). Không có đường này thì
          // bàn không bao giờ rời được chế độ hoàn.
          force: body.force === true,
        });
        return { station_id: stationId, ok: true, capture_id: r.captureId, still_held: r.stillHeld };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[returns/capture] ${action} lỗi station=${stationId}: ${message}`);
        return { station_id: stationId, ok: false, error: message };
      }
    }),
  );

  const statuses = await readCaptureStatuses({ admin, organizationId: ctx.organizationId });
  const withStatus = results.map((r) => ({ ...r, ...statusView(statuses.get(r.station_id), holder) }));

  // Tương thích giao diện cũ gửi một station_id: trả phẳng như đợt 5.
  if (!Array.isArray(body.station_ids) && withStatus.length === 1) {
    const one = withStatus[0];
    if (!one.ok && one.error && action !== "heartbeat") {
      const status = one.error === "station_not_found" ? 404 : 500;
      return NextResponse.json({ error: one.error === "station_not_found" ? one.error : "capture_failed", message: one.error }, { status });
    }
    return NextResponse.json({ ...one, ok: one.ok });
  }

  return NextResponse.json({ ok: withStatus.every((r) => r.ok), results: withStatus });
}

/**
 * Không nêu bàn: danh sách bàn KÈM trạng thái phiên của từng bàn — trang
 * giám sát cần cả kho trong một lần hỏi. Nêu `station_id`: trạng thái một bàn.
 *
 * Trả danh sách bàn ở đây chứ không bắt trang gọi /api/packing-stations:
 * quyền của hai trang khác nhau, người xem hàng hoàn không nhất thiết có
 * quyền xem thiết bị kho.
 */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const stationId = req.nextUrl.searchParams.get("station_id") ?? "";
  const holder = moduleHolder(ctx.userId, req.nextUrl.searchParams.get("tab_id"));

  let statuses: Map<string, StationCaptureStatus>;
  try {
    statuses = await readCaptureStatuses({ admin, organizationId: ctx.organizationId });
  } catch {
    return NextResponse.json({ error: "status_failed" }, { status: 500 });
  }

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
    return NextResponse.json({
      ok: true,
      stations: (stations ?? []).map((s) => ({
        ...s,
        capture: statusView(statuses.get(s.id as string), holder),
      })),
    });
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

  return NextResponse.json({ ok: true, ...statusView(statuses.get(stationId), holder) });
}
