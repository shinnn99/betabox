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
