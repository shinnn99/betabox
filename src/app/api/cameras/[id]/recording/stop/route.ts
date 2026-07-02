import { NextResponse } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import {
  getActiveSession,
  markSessionStopped,
} from "@/lib/camera/recording-service";
import { stopRecording } from "@/lib/camera/recording";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.recording.control");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const session = await getActiveSession(ctx.organizationId, id);

  // Mark the session as `stopped` BEFORE asking ffmpeg to exit. The
  // recording's onExit handler races with us: if ffmpeg flushes faster
  // than we can update the DB, onExit sees status='recording' and flips
  // the row to `error` with the benign stderr tail (timestamp warnings,
  // non-monotonic DTS) — making every clean stop look like a crash.
  // Flipping to `stopped` first means onExit's getActiveSession() returns
  // null and it leaves the row alone.
  if (session) {
    await markSessionStopped(session.id);
  }

  const result = await stopRecording(id);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.recording.stop",
    targetType: "camera",
    targetId: id,
    metadata: {
      session_id: session?.id ?? null,
      forced: result.forced,
      had_process: result.stopped,
    },
  });

  return NextResponse.json({
    ok: true,
    stopped: result.stopped,
    forced: result.forced,
  });
}
