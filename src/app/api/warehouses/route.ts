import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { getScopedClient } from "@/lib/supabase/scoped-client";
import { audit } from "@/lib/audit";

export async function GET() {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const scoped = await getScopedClient(ctx);
  const { data, error } = await scoped
    .select(
      "warehouses",
      "id, code, name, address, status, session_fallback_seconds, created_at",
    )
    .order("code");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ warehouses: data ?? [] });
}

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("warehouse.create");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  const address = body.address ? String(body.address).trim() : null;

  if (!code || !name) {
    return NextResponse.json(
      { error: "validation", message: "Mã kho và tên kho là bắt buộc." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("warehouses")
    .insert({ organization_id: ctx.organizationId, code, name, address })
    .select("id, code, name, address, status, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "warehouse.create",
    targetType: "warehouse",
    targetId: data.id,
    metadata: { code, name },
  });

  return NextResponse.json({ warehouse: data }, { status: 201 });
}
