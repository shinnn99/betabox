import { NextResponse } from "next/server";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { getCameraRow } from "@/lib/camera/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueProbeCodec } from "@/lib/agent-commands/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 1.2: enqueue probe_codec cho camera. Agent tự build RTSP từ credential
 * có sẵn (đường /api/agent/recording-credentials), gọi probeCodec,
 * report result qua command-result. Callback nhánh probe_codec ghi
 * cameras.codec_detected + codec_warning + codec_probed_at.
 *
 * Async: endpoint trả 202 với command_id ngay. UI có thể poll cameras
 * row để thấy codec_probed_at cập nhật, hoặc chỉ chờ vài giây rồi reload.
 */
export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.test");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const row = await getCameraRow(ctx.organizationId, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Chọn 1 agent active của org để giao job. Không hỏi client agent_id.
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

  try {
    const { command_id } = await enqueueProbeCodec({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      cameraId: id,
    });

    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.probe_codec.enqueued",
      targetType: "camera",
      targetId: id,
      metadata: { command_id, agent_id: agent.id },
    });

    return NextResponse.json(
      { ok: true, command_id, agent_id: agent.id },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: "enqueue_failed",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
