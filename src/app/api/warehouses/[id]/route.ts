import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { getScopedClient } from "@/lib/supabase/scoped-client";
import { audit } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const scoped = await getScopedClient(ctx);
  const { data, error } = await scoped
    .select("warehouses", "id, code, name, address, status, session_fallback_seconds, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ warehouse: data });
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("warehouse.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") update.name = body.name.trim();
  if (typeof body.code === "string") update.code = body.code.trim().toUpperCase();
  if (typeof body.address === "string" || body.address === null) update.address = body.address;
  if (typeof body.status === "string") update.status = body.status;
  if (typeof body.session_fallback_seconds === "number" && body.session_fallback_seconds > 0) {
    update.session_fallback_seconds = Math.floor(body.session_fallback_seconds);
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("warehouses")
    .update(update)
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "warehouse.update",
    targetType: "warehouse",
    targetId: id,
    metadata: { changes: update },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("warehouse.delete");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();
  const { error } = await admin
    .from("warehouses")
    .delete()
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "warehouse.delete",
    targetType: "warehouse",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
