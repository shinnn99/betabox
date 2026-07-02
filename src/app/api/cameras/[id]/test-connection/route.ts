import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { getCameraRow } from "@/lib/camera/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueTestCameraConnection } from "@/lib/agent-commands/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lát 2 SaaS refactor: test-connection chuyển từ chạy ffmpeg trên web
 * → enqueue agent-command. Web Vercel serverless không có ffmpeg VÀ
 * không tới được camera LAN — buộc phải qua agent tại kho.
 *
 * Sync (cũ): web spawn ffmpeg → chờ ~5s → trả kết quả trong response.
 * Async (mới): web enqueue command → trả 202 + command_id → UI poll
 * cameras.last_test_result cho tới khi cập nhật.
 *
 * Callback vào command-result branch test_camera_connection ghi
 * cameras.last_test_result + last_tested_at (dùng lại infra sẵn có).
 */
function readTransport(req: NextRequest): "tcp" | "udp" | "auto" {
  const t = req.nextUrl.searchParams.get("transport");
  if (t === "tcp" || t === "udp" || t === "auto") return t;
  return "auto";
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("camera.test");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const row = await getCameraRow(ctx.organizationId, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Chọn agent active của org (giống probe-codec).
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

  const transport = readTransport(req);
  try {
    const { command_id } = await enqueueTestCameraConnection({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      cameraId: id,
      transport,
    });

    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "camera.test_connection.enqueued",
      targetType: "camera",
      targetId: id,
      metadata: { command_id, agent_id: agent.id, transport_requested: transport },
    });

    return NextResponse.json(
      { ok: true, command_id, agent_id: agent.id },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: "enqueue_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
