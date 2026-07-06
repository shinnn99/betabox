import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

const EDITABLE_FIELDS = [
  "name",
  "logo_url",
] as const;

export async function GET() {
  const ctx = await requirePermission("organization.view");
  if (isError(ctx)) return ctx;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, slug, logo_url, status, created_at, updated_at")
    .eq("id", ctx.organizationId)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ organization: data });
}

export async function PATCH(req: Request) {
  const ctx = await requirePermissionStrict("organization.update");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const f of EDITABLE_FIELDS) {
    if (f in body) {
      const v = body[f];
      update[f] = typeof v === "string" ? v.trim() || null : v;
    }
  }

  if (typeof update.name === "string" && update.name.length === 0) {
    return NextResponse.json(
      { error: "validation", message: "Tên tổ chức không được rỗng." },
      { status: 400 }
    );
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .update(update)
    .eq("id", ctx.organizationId)
    .select("id, name, slug, logo_url, status, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "organization.update",
    targetType: "organization",
    targetId: ctx.organizationId,
    metadata: { changes: update },
  });

  return NextResponse.json({ organization: data });
}
