import { NextResponse } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { getCameraRow } from "@/lib/camera/service";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getActiveSession,
  insertSession,
  markSessionStopped,
} from "@/lib/camera/recording-service";
import {
  enqueueStartRecording,
  enqueueStopRecording,
} from "@/lib/agent-commands/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lát 2 SaaS refactor: restart = stop + start theo enqueue-command
 * pattern. Nếu có session đang chạy → mark stopped + enqueue stop →
 * tạo session mới + enqueue start.
 */
const DEFAULT_SEGMENT = Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60);
const DEFAULT_TRANSPORT = ((): "tcp" | "udp" => {
  const v = process.env.CAMERA_RECORDING_TRANSPORT;
  return v === "udp" ? "udp" : "tcp";
})();

export async function POST(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.recording.control");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    segment_seconds?: number;
    transport?: "tcp" | "udp";
  };

  const cameraRow = await getCameraRow(ctx.organizationId, id);
  if (!cameraRow) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: agent } = await admin
    .from("warehouse_agents")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!agent) {
    return NextResponse.json(
      { error: "no_agent", message: "Chưa có agent nào cho tổ chức." },
      { status: 409 },
    );
  }

  const existing = await getActiveSession(ctx.organizationId, id);
  let stopCommandId: string | null = null;
  if (existing) {
    await markSessionStopped(existing.id);
    try {
      const enq = await enqueueStopRecording({
        organizationId: ctx.organizationId,
        agentId: agent.id,
        cameraId: id,
        sessionId: existing.id,
      });
      stopCommandId = enq.command_id;
    } catch {
      // Không throw — tiếp tục start; agent lifecycle sẽ xử lý.
    }
  }

  const transport = body.transport === "udp" ? "udp" : (body.transport ?? DEFAULT_TRANSPORT);
  const segmentSeconds = body.segment_seconds ?? DEFAULT_SEGMENT;
  const outputDir = `_agent_managed/${cameraRow.camera_code}`;

  const inserted = await insertSession({
    organizationId: ctx.organizationId,
    cameraId: id,
    transport,
    segmentSeconds,
    outputDir,
    createdBy: ctx.userId,
  });

  if (inserted.kind === "already_active") {
    return NextResponse.json(
      {
        error: "already_recording",
        message: "Camera đã có session mới (race).",
        session: inserted.session,
      },
      { status: 409 },
    );
  }

  const newSession = inserted.session;

  let startCommandId: string;
  try {
    const enq = await enqueueStartRecording({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      cameraId: id,
      sessionId: newSession.id,
    });
    startCommandId = enq.command_id;
  } catch (err) {
    const { error: markErr } = await admin
      .from("camera_recording_sessions")
      .update({
        status: "error",
        stopped_at: new Date().toISOString(),
        error_message: `enqueue_failed: ${(err as Error).message}`,
      })
      .eq("id", newSession.id);
    if (markErr) {
      console.error(
        `[recording.restart] failed to mark session error after enqueue failure session=${newSession.id} code=${markErr.code ?? "?"} message=${markErr.message}`,
      );
    }
    return NextResponse.json(
      { error: "enqueue_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.recording.restart.enqueued",
    targetType: "camera",
    targetId: id,
    metadata: {
      old_session_id: existing?.id ?? null,
      new_session_id: newSession.id,
      stop_command_id: stopCommandId,
      start_command_id: startCommandId,
      agent_id: agent.id,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      old_session_id: existing?.id ?? null,
      new_session_id: newSession.id,
      stop_command_id: stopCommandId,
      start_command_id: startCommandId,
    },
    { status: 202 },
  );
}
