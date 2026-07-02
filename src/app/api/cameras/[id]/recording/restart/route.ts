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

// Restart = stop the current ffmpeg (if any) + close the DB session,
// then forward to the start route. We do the forward by HTTP so the
// start logic stays in one place. The cookie/auth header from the
// caller is preserved via forwarding the original request body.
export async function POST(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.recording.control");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  // Stop current.
  const existing = await getActiveSession(ctx.organizationId, id);
  await stopRecording(id);
  if (existing) {
    await markSessionStopped(existing.id, { errorMessage: "Restarted by user" });
  }

  // Re-use the same body for the new start (segment_seconds / transport).
  const bodyText = await req.text();

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.recording.restart",
    targetType: "camera",
    targetId: id,
    metadata: { previous_session_id: existing?.id ?? null },
  });

  // Forward to start: same origin, same cookies. We construct from the
  // incoming request URL so any host/proxy is preserved.
  const startUrl = new URL(req.url);
  startUrl.pathname = startUrl.pathname.replace(/\/restart$/, "/start");
  const fwd = await fetch(startUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Pass through cookies so the start route sees the same session.
      cookie: req.headers.get("cookie") ?? "",
    },
    body: bodyText || "{}",
  });
  const data = await fwd.json().catch(() => ({}));
  return NextResponse.json(data, { status: fwd.status });
}
