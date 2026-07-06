import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";

const IMPERSONATE_COOKIE = "impersonate_org_id";

// POST /api/platform/impersonate
// Body: { orgId: string }
// - Verify platform-admin (via requirePlatformRole).
// - Verify org tồn tại.
// - Ghi audit TRƯỚC khi set cookie: fail-closed. Nếu audit fail → không
//   cho impersonate (không có bằng chứng = không được phép).
// - Set cookie HttpOnly (JS không đọc/sửa), SameSite=Strict (không cross-site).
export async function POST(req: NextRequest) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  let body: { orgId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const orgId = body.orgId;
  if (!orgId || typeof orgId !== "string") {
    return NextResponse.json({ error: "missing_orgId" }, { status: 400 });
  }

  // Verify org tồn tại (destruct .error — Supabase không throw khi DB lỗi)
  const admin = createAdminClient();
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) {
    console.error(
      `[impersonate] org lookup failed orgId=${orgId} code=${orgErr.code ?? "?"} message=${orgErr.message}`,
    );
    return NextResponse.json({ error: "org_lookup_failed" }, { status: 500 });
  }
  if (!org) {
    return NextResponse.json({ error: "org_not_found" }, { status: 404 });
  }

  // Audit start impersonation TRƯỚC khi set cookie — fail-closed.
  const auditRes = await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: orgId,
    action: "platform.org.impersonate.start",
    targetType: "organization",
    targetId: orgId,
    metadata: { target_org_name: org.name },
  });
  if (!auditRes.ok) {
    // Không có audit = không được phép impersonate. User thấy 503 để retry.
    return NextResponse.json(
      { error: "audit_failed" },
      { status: 503 },
    );
  }

  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATE_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    // Không maxAge → session cookie, đóng browser hết.
    // Platform admin thao tác trong 1 session; đóng browser = thoát impersonate.
  });

  return NextResponse.json({ ok: true, orgId, orgName: org.name });
}

// DELETE /api/platform/impersonate — thoát impersonate (clear cookie).
// Ghi audit stop nhưng KHÔNG fail-closed: thoát impersonate là hành động
// "an toàn hơn" (thu hồi quyền); nếu audit fail vẫn cho thoát để không
// kẹt user trong trạng thái impersonate. Log lỗi audit ra console.
export async function DELETE() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const cookieStore = await cookies();
  const currentOrgId = cookieStore.get(IMPERSONATE_COOKIE)?.value || null;

  // Ghi audit (không fail-closed — xem comment header).
  await logPlatformAudit({
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    impersonatingOrgId: currentOrgId,
    action: "platform.org.impersonate.stop",
    targetType: currentOrgId ? "organization" : null,
    targetId: currentOrgId,
  });

  cookieStore.set(IMPERSONATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 0,
  });
  return NextResponse.json({ ok: true });
}
