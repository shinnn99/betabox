import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "./server";
import { createAdminClient } from "./admin";
import type { Role } from "@/lib/auth";

export interface ApiContext {
  userId: string;
  email: string;
  organizationId: string;
  role: Role;
}

async function readClaims(): Promise<
  | { userId: string; email: string; organizationId: string; role: Role }
  | NextResponse
> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const claims = data.claims as Record<string, unknown>;
  const userId = claims.sub as string;
  const email = (claims.email as string) ?? "";
  const organizationId = (claims.organization_id as string) ?? "";
  const role = (claims.user_role as Role) ?? "viewer";

  if (!organizationId) {
    return NextResponse.json(
      { error: "no_organization", message: "User chưa được gán organization." },
      { status: 403 }
    );
  }

  return { userId, email, organizationId, role };
}

async function checkPermission(role: Role, permission: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("role_permission_matrix")
    .select("permission_code")
    .eq("role", role)
    .eq("permission_code", permission)
    .maybeSingle();
  return !!data;
}

/**
 * Bình thường — đọc role từ JWT. Nhanh, chấp nhận token chưa refresh sau khi đổi role.
 */
export async function requirePermission(
  permission: string
): Promise<ApiContext | NextResponse> {
  const ctx = await readClaims();
  if (ctx instanceof NextResponse) return ctx;

  if (!(await checkPermission(ctx.role, permission))) {
    return NextResponse.json({ error: "forbidden", permission }, { status: 403 });
  }
  return ctx;
}

/**
 * Strict — luôn đọc lại role hiện tại từ DB. Dùng cho thao tác nhạy cảm:
 * user.create/update/delete, staff.qr.regenerate, work_session.force_end, ...
 */
export async function requirePermissionStrict(
  permission: string
): Promise<ApiContext | NextResponse> {
  const ctx = await readClaims();
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from("user_profiles")
    .select("role, status, organization_id")
    .eq("id", ctx.userId)
    .single();

  if (error || !profile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 403 });
  }
  if (profile.status !== "active") {
    return NextResponse.json({ error: "account_disabled" }, { status: 403 });
  }
  if (profile.organization_id !== ctx.organizationId) {
    return NextResponse.json({ error: "org_mismatch" }, { status: 403 });
  }

  const realRole = profile.role as Role;
  if (!(await checkPermission(realRole, permission))) {
    return NextResponse.json({ error: "forbidden", permission }, { status: 403 });
  }

  return { ...ctx, role: realRole };
}

export function isError(x: ApiContext | NextResponse): x is NextResponse {
  return x instanceof NextResponse;
}
