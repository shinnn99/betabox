import { NextResponse } from "next/server";
import {
  isError,
  requirePermissionStrict,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getOpenSessionForStop,
  markSessionStopped,
} from "@/lib/camera/recording-service";
import { enqueueStopRecording } from "@/lib/agent-commands/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lát 2 SaaS refactor: recording/stop chuyển từ gọi stopRecording()
 * trong Next.js process → enqueue command cho agent. Cùng lý do start:
 * web Vercel không quản lý ffmpeg process. Đóng cọc double-spawn.
 *
 * Flow:
 *   1. Lấy active session (nếu không có → 409).
 *   2. markSessionStopped (idempotent — nếu race với agent onExit thì
 *      hàm không lỗi, chỉ update field ngày dừng).
 *   3. Enqueue stop_recording command cho agent → agent kill ffmpeg.
 *   4. Trả 202 với command_id.
 */
export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.recording.control");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();

  // Session CÒN MỞ (stopped_at IS NULL), không chỉ status='recording'.
  // Session 'error'/'connection_lost' vẫn phải dừng được: agent ở kho có
  // thể đang giữ desired và spawn lại mỗi 5 phút bất kể cloud ghi gì.
  const session = await getOpenSessionForStop(ctx.organizationId, id);
  if (!session) {
    // Không còn gì để dừng → THÀNH CÔNG, không phải lỗi. Trả 409 ở đây
    // biến "đã dừng rồi" thành ngõ cụt trên UI mà người dùng không hiểu
    // phải làm gì tiếp.
    return NextResponse.json(
      { ok: true, already_stopped: true, session_id: null, command_id: null },
      { status: 200 },
    );
  }

  // Idempotent: đã có lệnh dừng chờ agent cho đúng camera này thì trả lại
  // lệnh đó. Bấm nhiều lần (hoặc double-click) không được đẻ hàng đợi
  // stop_recording trùng nhau.
  const { data: pending } = await admin
    .from("agent_commands")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("type", "stop_recording")
    .in("status", ["pending", "taken"])
    .eq("payload->>camera_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pending) {
    return NextResponse.json(
      {
        ok: true,
        deduplicated: true,
        session_id: session.id,
        command_id: pending.id,
      },
      { status: 202 },
    );
  }

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

  // Mark session stopped TRƯỚC khi agent xử lý (giống pattern cũ:
  // tránh onExit ffmpeg agent flip session sang 'error').
  await markSessionStopped(session.id);

  let commandId: string;
  try {
    const enq = await enqueueStopRecording({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      cameraId: id,
      sessionId: session.id,
    });
    commandId = enq.command_id;
  } catch (err) {
    return NextResponse.json(
      { error: "enqueue_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "camera.recording.stop.enqueued",
    targetType: "camera",
    targetId: id,
    metadata: {
      session_id: session.id,
      command_id: commandId,
      agent_id: agent.id,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      session_id: session.id,
      command_id: commandId,
    },
    { status: 202 },
  );
}
