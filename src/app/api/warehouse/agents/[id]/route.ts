import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * DELETE — gỡ agent khỏi org. Hard delete (agent_commands sẽ orphan
 * organization_id ổn nhờ ON DELETE cascade nếu FK có; nếu không, log
 * còn lại là dữ liệu audit tự nhiên).
 *
 * Ca dùng: khách đóng cửa 1 kho, hoặc thay máy PC hoàn toàn. Không nên
 * dùng cho "reset secret" — có API riêng.
 */
export async function DELETE(_req: Request, ctx: RouteContext) {
  const authCtx = await requirePermissionStrict("station_device.create");
  if (isError(authCtx)) return authCtx;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: agent } = await admin
    .from("warehouse_agents")
    .select("id, code, organization_id")
    .eq("id", id)
    .maybeSingle();
  if (!agent || agent.organization_id !== authCtx.organizationId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { error } = await admin
    .from("warehouse_agents")
    .delete()
    .eq("id", id);
  if (error) {
    return NextResponse.json(
      { error: "delete_failed", message: error.message },
      { status: 500 },
    );
  }

  await audit({
    organizationId: authCtx.organizationId,
    actorUserId: authCtx.userId,
    actorEmail: authCtx.email,
    action: "warehouse_agent.delete",
    targetType: "warehouse_agent",
    targetId: id,
    metadata: { code: agent.code },
  });

  return NextResponse.json({ ok: true });
}
