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
} from "@/lib/camera/recording-service";
import { enqueueStartRecording } from "@/lib/agent-commands/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lát 2 SaaS refactor: recording/start chuyển từ spawn ffmpeg trong
 * Next.js process → enqueue command cho agent. Web Vercel không spawn
 * được ffmpeg VÀ không tới được camera LAN. Đóng cọc BLOCKS-GO-LIVE
 * Lát 2 (double-spawn) — chỉ còn 1 đường ghi qua agent.
 *
 * Flow:
 *   1. Verify camera thuộc org.
 *   2. Kiểm session đang chạy → trả 409 (idempotent).
 *   3. Insert session status='recording'.
 *   4. Enqueue start_recording command cho agent poll → agent spawn ffmpeg.
 *   5. Trả 202 với session_id + command_id.
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

  const existing = await getActiveSession(ctx.organizationId, id);
  if (existing) {
    return NextResponse.json(
      {
        error: "already_recording",
        message: "Camera đang được ghi.",
        session: existing,
      },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data: agent } = await admin
    .from("warehouse_agents")
    .select("id, last_seen_at")
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
        message: "Camera đang được ghi (race).",
        session: inserted.session,
      },
      { status: 409 },
    );
  }

  const session = inserted.session;

  let commandId: string;
  try {
    const enq = await enqueueStartRecording({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      cameraId: id,
      sessionId: session.id,
    });
    commandId = enq.command_id;
  } catch (err) {
    await admin
      .from("camera_recording_sessions")
      .update({
        status: "error",
        stopped_at: new Date().toISOString(),
        error_message: `enqueue_failed: ${(err as Error).message}`,
      })
      .eq("id", session.id);
    return NextResponse.json(
      { error: "enqueue_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.recording.start.enqueued",
    targetType: "camera",
    targetId: id,
    metadata: {
      session_id: session.id,
      command_id: commandId,
      agent_id: agent.id,
      transport_requested: transport,
      segment_seconds: segmentSeconds,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      session_id: session.id,
      command_id: commandId,
      agent_id: agent.id,
    },
    { status: 202 },
  );
}
