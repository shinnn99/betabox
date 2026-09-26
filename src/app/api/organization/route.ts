import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { RETENTION_FIELDS, retentionFieldError } from "@/lib/config/validate";

const EDITABLE_FIELDS = [
  "name",
  "logo_url",
  "retention_days",
  "return_retention_days",
] as const;

export async function GET() {
  const ctx = await requirePermission("organization.view");
  if (isError(ctx)) return ctx;

  // Admin client + explicit .eq('id') vì:
  // (1) organizations không có nhánh platform-admin bypass trong RLS SELECT
  //     policy (chỉ id = app.current_org_id()); platform admin impersonate
  //     → app.current_org_id()=NULL → 0 row → .single() throw "Cannot coerce".
  // (2) organizations không cover bởi getScopedClient helper (chỉ SELECT bảng
  //     org-scoped bằng organization_id, không lookup by id).
  // Guard requirePermission đã verify quyền tenant, ctx.organizationId từ token.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("id, name, slug, logo_url, status, retention_days, return_retention_days, created_at, updated_at")
    .eq("id", ctx.organizationId)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ organization: data });
}

export async function PATCH(req: Request) {
  const ctx = await requirePermissionStrict("organization.update", req);
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

  // Luật chung với route platform — src/lib/config/validate.ts.
  for (const field of RETENTION_FIELDS) {
    if (!(field in update)) continue;
    const message = retentionFieldError(field, update[field]);
    if (message) {
      return NextResponse.json({ error: "validation", message }, { status: 400 });
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  // Admin client — cùng lý do GET (organizations RLS UPDATE có nhánh platform
  // nhưng nhất quán với GET dùng admin, tránh 2 client 2 nơi cùng file).
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .update(update)
    .eq("id", ctx.organizationId)
    .select("id, name, slug, logo_url, status, retention_days, return_retention_days, created_at, updated_at")
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
