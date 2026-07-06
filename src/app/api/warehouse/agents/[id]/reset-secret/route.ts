import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Reset secret cho agent hiện có. Sinh secret 32 bytes mới, ghi đè
 * DB. Trả về secret mới DUY NHẤT 1 LẦN trong response.
 *
 * Ca dùng: khách quên copy secret lúc tạo, hoặc secret bị lộ (VD nhân
 * viên cũ copy), hoặc đổi máy kho. Agent cũ ngừng hoạt động ngay khi
 * DB cập nhật (agent request tiếp theo → HMAC mismatch → 401
 * unknown_agent hoặc signature_invalid).
 *
 * Không đổi code/name — chỉ secret. Cài lại installer trên máy kho với
 * secret mới, giữ nguyên code.
 */
export async function POST(_req: Request, ctx: RouteContext) {
  const authCtx = await requirePermissionStrict("station_device.create");
  if (isError(authCtx)) return authCtx;

  const { id } = await ctx.params;
  const admin = createAdminClient();

  // HIGH-10: verify agent thuộc org qua eq(org) ở tầng query.
  const { data: agent, error: lookupErr } = await admin
    .from("warehouse_agents")
    .select("id, code, name")
    .eq("id", id)
    .eq("organization_id", authCtx.organizationId)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json(
      { error: "lookup_failed", message: lookupErr.message },
      { status: 500 },
    );
  }
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const newSecret = randomBytes(32).toString("hex");
  const { error } = await admin
    .from("warehouse_agents")
    .update({ secret: newSecret, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", authCtx.organizationId);
  if (error) {
    return NextResponse.json(
      { error: "reset_failed", message: error.message },
      { status: 500 },
    );
  }

  await audit({
    organizationId: authCtx.organizationId,
    actorUserId: authCtx.userId,
    actorEmail: authCtx.email,
    action: "warehouse_agent.reset_secret",
    targetType: "warehouse_agent",
    targetId: id,
    metadata: { code: agent.code },
  });

  return NextResponse.json({
    agent: { id: agent.id, code: agent.code, name: agent.name },
    secret: newSecret,
  });
}
