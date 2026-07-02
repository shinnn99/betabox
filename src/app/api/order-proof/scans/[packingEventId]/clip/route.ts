/**
 * @deprecated 2026-07-03 (Lát 3d list migration)
 *
 * Endpoint này chạy stack cũ: backend Vercel tự spawn ffmpeg + đọc file
 * từ `clip_path` là ổ agent local. Trên Vercel serverless KHÔNG có ffmpeg
 * và KHÔNG đọc được ổ agent — chạy thật ở prod sẽ fail hàng loạt.
 *
 * UI `/dashboard/videos` đã ngừng gọi endpoint này từ 2026-07-03 (chuyển
 * mọi hành động cắt/upload qua `/api/order-proof/[pe_id]/watch` — luồng
 * agent-pattern 3c/3d, một cửa).
 *
 * Giữ code (không xóa ngay) để tránh vỡ ngầm nếu còn caller script/
 * backfill nào chưa grep ra. Xóa sau khi verify prod 1-2 tuần im lặng
 * với grep DƯƠNG 0 caller ở cả `src/`, `warehouse-agent/`, `scripts/`.
 *
 * Nếu bạn định thêm caller mới cho endpoint này — DỪNG. Dùng `/watch`.
 */
import { NextResponse } from "next/server";
import {
  isError,
  requirePermission,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import {
  generateClipForEvent,
  getReadyClipForEvent,
  regenerateClipForEvent,
} from "@/lib/order-proof/service";

interface RouteContext {
  params: Promise<{ packingEventId: string }>;
}

export const runtime = "nodejs";

// GET — status only (does not trigger generation). Permission view.
export async function GET(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;
  const { packingEventId } = await params;

  try {
    const clip = await getReadyClipForEvent(ctx.organizationId, packingEventId);
    return NextResponse.json({ clip });
  } catch (err) {
    return NextResponse.json(
      { error: "lookup_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}

// POST — generate (or return existing). Permission generate (strict).
// Body: { regenerate?: boolean, cut_mode?: "copy" | "reencode" }
export async function POST(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("order_proof.generate");
  if (isError(ctx)) return ctx;
  const { packingEventId } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    regenerate?: boolean;
    cut_mode?: "copy" | "reencode";
  };

  const cutMode = body.cut_mode === "reencode" ? "reencode" : "copy";
  const runner = body.regenerate ? regenerateClipForEvent : generateClipForEvent;

  const outcome = await runner({
    organizationId: ctx.organizationId,
    packingEventId,
    generatedBy: ctx.userId,
    cutMode,
  });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: body.regenerate
      ? "order_proof.clip.regenerate"
      : "order_proof.clip.generate",
    targetType: "packing_event",
    targetId: packingEventId,
    metadata: {
      ok: outcome.ok,
      reason: outcome.reason,
      cut_mode: cutMode,
      clip_id: outcome.clip?.id ?? null,
      duration_seconds: outcome.clip?.duration_seconds ?? null,
    },
  });

  if (!outcome.ok) {
    const status =
      outcome.reason === "not_found"
        ? 404
        : outcome.reason === "segment_still_open"
          ? 425 // Too Early — semantic match
          : outcome.reason === "no_camera" || outcome.reason === "no_segments"
            ? 422
            : 500;
    return NextResponse.json(
      { ok: false, reason: outcome.reason, message: outcome.message },
      { status },
    );
  }

  return NextResponse.json({ ok: true, clip: outcome.clip });
}
