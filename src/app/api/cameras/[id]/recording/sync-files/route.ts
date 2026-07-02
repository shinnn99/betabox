import { NextResponse } from "next/server";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { getCameraRow } from "@/lib/camera/service";
import {
  getActiveSession,
  syncCameraFiles,
} from "@/lib/camera/recording-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

// Manual scan/upsert of segment files. Anyone with view can trigger
// this — it's idempotent and doesn't change recording state.
export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("camera.recording.view");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const camera = await getCameraRow(ctx.organizationId, id);
  if (!camera) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const active = await getActiveSession(ctx.organizationId, id);

  try {
    const stats = await syncCameraFiles(
      ctx.organizationId,
      { id: camera.id, camera_code: camera.camera_code },
      active?.id ?? null,
    );
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.recording.sync_files",
      targetType: "camera",
      targetId: id,
      metadata: stats,
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    return NextResponse.json(
      { error: "sync_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
