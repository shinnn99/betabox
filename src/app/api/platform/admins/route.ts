import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import type { PlatformRole } from "@/lib/platform/admin-check";

const VALID_PLATFORM_ROLES: PlatformRole[] = ["platform_owner", "platform_support"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// GET /api/platform/admins — list platform admins (platform_support đọc được)
// ============================================================================
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("platform_admins")
    .select("id, role, status, created_at, created_by, notes")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich email từ auth.users
  const ids = (rows ?? []).map((r) => r.id);
  const createdByIds = (rows ?? [])
    .map((r) => r.created_by)
    .filter((id): id is string => id !== null);
  const allIds = Array.from(new Set([...ids, ...createdByIds]));

  const emailMap = new Map<string, string>();
  await Promise.all(
    allIds.map(async (id) => {
      const { data: au } = await admin.auth.admin.getUserById(id);
      if (au?.user?.email) emailMap.set(id, au.user.email);
    })
  );

  const enriched = (rows ?? []).map((r) => ({
    ...r,
    email: emailMap.get(r.id) ?? "",
    created_by_email: r.created_by ? emailMap.get(r.created_by) ?? "" : null,
  }));

  return NextResponse.json({ admins: enriched });
}

// ============================================================================
// POST /api/platform/admins — thêm platform admin (CHỈ platform_owner)
// GATE cứng: requirePlatformRole("platform_owner")
// ============================================================================
export async function POST(req: Request) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const targetUserId = String(body.user_id ?? "").trim();
  const role = body.role as PlatformRole;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!targetUserId || !UUID_PATTERN.test(targetUserId)) {
    return NextResponse.json(
      { error: "validation", message: "user_id phải là UUID hợp lệ." },
      { status: 400 }
    );
  }
  if (!VALID_PLATFORM_ROLES.includes(role)) {
    return NextResponse.json(
      { error: "validation", message: "role phải là platform_owner hoặc platform_support." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(targetUserId);
  if (authErr || !authUser?.user) {
    return NextResponse.json(
      { error: "user_not_found", message: "User không tồn tại." },
      { status: 404 }
    );
  }

  const { data: existing } = await admin
    .from("platform_admins")
    .select("id")
    .eq("id", targetUserId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "already_platform_admin", message: "User đã là platform admin." },
      { status: 409 }
    );
  }

  const { error: insertErr } = await admin.from("platform_admins").insert({
    id: targetUserId,
    role,
    status: "active",
    created_by: ctx.userId,
    notes,
  });
  if (insertErr) {
    if (insertErr.code === "23505") {
      return NextResponse.json({ error: "already_platform_admin" }, { status: 409 });
    }
    return NextResponse.json({ error: "insert_failed", message: insertErr.message }, { status: 500 });
  }

  // Audit
  try {
    await admin.from("platform_audit_log").insert({
      actor_user_id: ctx.userId,
      actor_email: ctx.email,
      impersonating_org_id: null,
      action: "platform.admin.add",
      target_type: "platform_admin",
      target_id: targetUserId,
      metadata: { role, target_email: authUser.user.email ?? null, notes },
    });
  } catch (auditErr) {
    console.error("[platform_audit_log] failed:", auditErr);
  }

  return NextResponse.json({ id: targetUserId, role }, { status: 201 });
}
