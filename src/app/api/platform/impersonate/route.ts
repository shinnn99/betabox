import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";

const IMPERSONATE_COOKIE = "impersonate_org_id";

// POST /api/platform/impersonate
// Body: { orgId: string }
// - Verify platform-admin (via requirePlatformRole).
// - Verify org tồn tại.
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

  // Verify org tồn tại
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "org_not_found" }, { status: 404 });
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

// DELETE /api/platform/impersonate — thoát impersonate (clear cookie)
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 0,
  });
  return NextResponse.json({ ok: true });
}
