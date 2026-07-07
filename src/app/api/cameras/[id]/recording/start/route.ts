import { NextResponse } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { getCameraRow } from "@/lib/camera/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueStartRecordingV2 } from "@/lib/agent-commands/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lát 2 SaaS refactor: recording/start chuyển từ spawn ffmpeg trong
 * Next.js process → enqueue command cho agent. Web Vercel không spawn
 * được ffmpeg VÀ không tới được camera LAN.
 *
 * B4 HIGH-12: rewrite qua RPC transactional `enqueue_start_recording`.
 * RPC dùng advisory xact lock per camera + check session (recording,
 * connection_lost) + command (pending, taken) trong 1 transaction.
 * Idempotent cho race double-click / 2 tab.
 *
 * Verdicts từ RPC → HTTP status:
 *   - 'created' → 202 Accepted với session_id + command_id.
 *   - 'already_recording' → 200 OK (idempotent, không phải error).
 *   - 'recording_state_unknown' → 409 Conflict với reason.
 *   - 'start_pending' → 200 OK với command_id (idempotent).
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

  let verdict: Awaited<ReturnType<typeof enqueueStartRecordingV2>>;
  try {
    verdict = await enqueueStartRecordingV2({
      organizationId: ctx.organizationId,
      cameraId: id,
      agentId: agent.id,
      createdBy: ctx.userId,
      transport,
      segmentSeconds,
      outputDir,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "enqueue_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  if (verdict.verdict === "created") {
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.recording.start.enqueued",
      targetType: "camera",
      targetId: id,
      metadata: {
        session_id: verdict.session_id,
        command_id: verdict.command_id,
        agent_id: agent.id,
        transport_requested: transport,
        segment_seconds: segmentSeconds,
      },
    });
    return NextResponse.json(
      {
        ok: true,
        session_id: verdict.session_id,
        command_id: verdict.command_id,
        agent_id: agent.id,
      },
      { status: 202 },
    );
  }

  if (verdict.verdict === "already_recording") {
    // Idempotent — không audit lại, trả 200.
    return NextResponse.json({
      ok: true,
      idempotent: "already_recording",
      session_id: verdict.session_id,
      message: "Camera đang được ghi.",
    });
  }

  if (verdict.verdict === "start_pending") {
    // Command chưa xử — idempotent trả command_id hiện có.
    return NextResponse.json({
      ok: true,
      idempotent: "start_pending",
      command_id: verdict.command_id,
      message: "Start command đã enqueued, agent sẽ xử lý.",
    });
  }

  // recording_state_unknown → 409
  return NextResponse.json(
    {
      error: "recording_state_unknown",
      session_id: verdict.session_id,
      message: verdict.reason,
    },
    { status: 409 },
  );
}
