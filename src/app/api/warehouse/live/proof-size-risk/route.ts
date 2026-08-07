import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { computeFinalizedClipWindow } from "@/lib/order-proof/clip-window";
import {
  estimateProofSize,
  getProofSizeWarnBytes,
  getProofUploadGuardBytes,
  percentile95BytesPerSecond,
  type ProofSizeEstimate,
  type SegmentForEstimate,
} from "@/lib/order-proof/proof-size-estimate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cảnh báo sớm: đơn nào sẽ sinh proof clip vượt trần upload.
 *
 * Tách khỏi /live/activity có chủ đích. Activity poll 3 giây; ước lượng
 * này cần query segment theo từng đơn nên đặt chung sẽ nhân chi phí lên
 * mỗi nhịp. Đơn đã đóng thì kích thước clip không đổi nữa, nên poll
 * chậm (khuyến nghị 60s) là đủ tươi.
 *
 * KHÔNG lọc riêng finalized_by_checkout. Hôm nay phần lớn rủi ro nằm ở
 * đó, nhưng nếu mai bitrate camera tăng lên 3 Mbps thì clip capped 190s
 * cũng vượt trần. Helper không được biết "checkout" là gì — bộ lọc
 * nghiệp vụ để ở phía hiển thị.
 */

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/**
 * Chỉ chạy ước lượng chính xác (query segment) cho đơn mà cửa sổ clip đủ
 * dài để CÓ THỂ chạm ngưỡng cảnh báo. Đơn 30s không cách nào thành
 * 47 MiB nên không đáng một round-trip.
 *
 * Ngưỡng sàng = nửa ngưỡng cảnh báo quy ra giây theo bitrate p95 của
 * chính camera đó. Hệ số 0.5 để một đơn có bitrate cao gấp đôi bình
 * thường vẫn lọt vào diện xét.
 */
const SCREEN_RATIO = 0.5;

/** Trần số đơn được query segment trong một request. */
const MAX_PRECISE_ESTIMATES = 20;

/** Số file ghi hình gần đây dùng để tính p95 mỗi camera. */
const RECENT_FILES_PER_CAMERA = 200;

interface RiskRow extends ProofSizeEstimate {
  packing_event_id: string;
  raw_event_id: string | null;
  waybill_code: string | null;
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
  const orgId = ctx.organizationId;
  const limit = parseLimit(req);
  const guardBytes = getProofUploadGuardBytes();
  const warnBytes = getProofSizeWarnBytes();

  // 1) Đơn ĐÃ ĐÓNG gần đây. Đơn 'open' không có biên thật nên không
  // ước lượng được (và cũng không được sinh proof — proof-clip-gate).
  const { data: events, error: evErr } = await admin
    .from("packing_events")
    .select(
      "id, raw_event_id, waybill_code, scanned_at, work_ended_at, work_duration_seconds, timing_status, proof_camera_id, warehouse_id",
    )
    .eq("organization_id", orgId)
    .eq("status", "valid")
    .not("work_ended_at", "is", null)
    .not("proof_camera_id", "is", null)
    .order("scanned_at", { ascending: false })
    .limit(limit);

  if (evErr) {
    return NextResponse.json({ error: evErr.message }, { status: 500 });
  }
  if (!events || events.length === 0) {
    return NextResponse.json({
      risks: [],
      upload_guard_bytes: guardBytes,
      warn_bytes: warnBytes,
    });
  }

  // 2) Config timing per kho — pre-roll và default_post vào cửa sổ clip.
  const warehouseIds = Array.from(
    new Set(events.map((e) => e.warehouse_id).filter((v): v is string => !!v)),
  );
  const { data: warehouses } = await admin
    .from("warehouses")
    .select("id, packing_timing_config")
    .in("id", warehouseIds.length > 0 ? warehouseIds : ["00000000-0000-0000-0000-000000000000"]);

  const timingByWarehouse = new Map<string, { pre: number; defaultPost: number }>();
  for (const w of warehouses ?? []) {
    const cfg = w.packing_timing_config as Record<string, unknown> | null;
    const pre = Number(cfg?.video_pre_seconds);
    const post = Number(cfg?.video_default_post_seconds);
    timingByWarehouse.set(w.id as string, {
      pre: Number.isFinite(pre) && pre >= 0 ? pre : 10,
      defaultPost: Number.isFinite(post) && post > 0 ? post : 60,
    });
  }

  // 3) Bitrate p95 gần đây per camera — dùng để sàng, và làm fallback
  // khi không đủ segment phủ cửa sổ.
  const cameraIds = Array.from(
    new Set(events.map((e) => e.proof_camera_id).filter((v): v is string => !!v)),
  );
  const p95ByCamera = new Map<string, number>();
  await Promise.all(
    cameraIds.map(async (cameraId) => {
      const { data: files } = await admin
        .from("camera_recording_files")
        .select("duration_seconds, file_size_bytes")
        .eq("organization_id", orgId)
        .eq("camera_id", cameraId)
        .gt("file_size_bytes", 0)
        .order("started_at", { ascending: false })
        .limit(RECENT_FILES_PER_CAMERA);
      const p95 = percentile95BytesPerSecond(files ?? []);
      if (p95) p95ByCamera.set(cameraId, p95);
    }),
  );

  // 4) Cửa sổ clip — DÙNG CHUNG hàm với bộ sinh clip.
  const withWindow = events.map((e) => {
    const timing = e.warehouse_id
      ? timingByWarehouse.get(e.warehouse_id) ?? { pre: 10, defaultPost: 60 }
      : { pre: 10, defaultPost: 60 };
    const window = computeFinalizedClipWindow({
      scannedAt: new Date(e.scanned_at as string),
      workEndedAt: e.work_ended_at as string,
      timingStatus: e.timing_status as string | null,
      workDurationSeconds: e.work_duration_seconds as number | null,
      preSeconds: timing.pre,
      defaultPostSeconds: timing.defaultPost,
    });
    return { event: e, window };
  });

  // 5) Sàng: chỉ đơn đủ dài để CÓ THỂ chạm ngưỡng mới query segment.
  const screened = withWindow.filter(({ event, window }) => {
    const p95 = event.proof_camera_id
      ? p95ByCamera.get(event.proof_camera_id as string)
      : undefined;
    if (!p95) return false; // Không có p95 → không sàng được, để fallback xử lý.
    return window.windowSeconds * p95 >= warnBytes * SCREEN_RATIO;
  });

  const precise = screened.slice(0, MAX_PRECISE_ESTIMATES);
  const truncated = screened.length - precise.length;
  if (truncated > 0) {
    // Không im lặng cắt: nếu kho bận tới mức vượt trần này thì ops cần
    // biết là còn đơn chưa được ước lượng chính xác.
    console.warn(
      `[proof-size-risk] org=${orgId} ${truncated} đơn vượt trần ${MAX_PRECISE_ESTIMATES} ` +
        `ước lượng chính xác — số còn lại dùng p95.`,
    );
  }

  // 6) Segment phủ cửa sổ, query theo từng đơn (mỗi query vài dòng).
  const segmentsByEvent = new Map<string, SegmentForEstimate[]>();
  await Promise.all(
    precise.map(async ({ event, window }) => {
      const { data: segs } = await admin
        .from("camera_recording_files")
        .select("started_at, ended_at, duration_seconds, file_size_bytes")
        .eq("organization_id", orgId)
        .eq("camera_id", event.proof_camera_id as string)
        .lte("started_at", window.clipEnd.toISOString())
        .gte("ended_at", window.clipStart.toISOString());
      segmentsByEvent.set(event.id as string, (segs ?? []) as SegmentForEstimate[]);
    }),
  );

  // 7) Ước lượng.
  const risks: RiskRow[] = withWindow.map(({ event, window }) => {
    const cameraId = event.proof_camera_id as string | null;
    const estimate = estimateProofSize({
      window,
      segments: segmentsByEvent.get(event.id as string) ?? [],
      fallbackBytesPerSecond: cameraId ? p95ByCamera.get(cameraId) ?? null : null,
      guardBytes,
      warnBytes,
    });
    return {
      packing_event_id: event.id as string,
      raw_event_id: (event.raw_event_id as string | null) ?? null,
      waybill_code: (event.waybill_code as string | null) ?? null,
      timing_status: (event.timing_status as string | null) ?? null,
      ...estimate,
    };
  });

  return NextResponse.json({
    risks,
    upload_guard_bytes: guardBytes,
    warn_bytes: warnBytes,
  });
}
