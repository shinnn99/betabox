import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import type { Role } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_ROLES: Role[] = [
  "owner",
  "admin",
  "warehouse_manager",
  "shift_leader",
  "packer",
  "viewer",
];

/**
 * Tạo user đăng nhập mới và link luôn vào staff.
 * Yêu cầu quyền staff.invite (đồng nghĩa user.create vì tạo auth user).
 */
export async function POST(req: Request, { params }: RouteContext) {
  const ctxInvite = await requirePermissionStrict("staff.invite");
  if (isError(ctxInvite)) return ctxInvite;
  const ctxCreate = await requirePermissionStrict("user.create");
  if (isError(ctxCreate)) return ctxCreate;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const role = body.role as Role;

  if (!email || !password || password.length < 8 || !VALID_ROLES.includes(role)) {
    return NextResponse.json(
      {
        error: "validation",
        message: "Email, mật khẩu (>=8 ký tự) và vai trò hợp lệ là bắt buộc.",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: staff } = await admin
    .from("staff_profiles")
    .select("id, organization_id, user_id, staff_code, full_name, phone")
    .eq("id", id)
    .single();
  if (!staff || staff.organization_id !== ctxInvite.organizationId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (staff.user_id) {
    return NextResponse.json(
      { error: "already_linked", message: "Nhân viên này đã có tài khoản đăng nhập." },
      { status: 400 }
    );
  }

  // Tạo auth user
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    return NextResponse.json(
      { error: createErr?.message ?? "create_failed" },
      { status: 400 }
    );
  }

  // Tạo profile
  const { error: profileErr } = await admin.from("user_profiles").insert({
    id: created.user.id,
    organization_id: ctxInvite.organizationId,
    role,
    full_name: staff.full_name,
    phone: staff.phone,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: profileErr.message }, { status: 400 });
  }

  // Link
  const { error: linkErr } = await admin
    .from("staff_profiles")
    .update({ user_id: created.user.id })
    .eq("id", id)
    .eq("organization_id", ctxInvite.organizationId);
  if (linkErr) {
    // rollback
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: linkErr.message }, { status: 400 });
  }

  await audit({
    organizationId: ctxInvite.organizationId,
    actorUserId: ctxInvite.userId,
    actorEmail: ctxInvite.email,
    action: "staff.invite",
    targetType: "staff",
    targetId: id,
    metadata: {
      staff_code: staff.staff_code,
      created_user_id: created.user.id,
      email,
      role,
    },
  });

  return NextResponse.json(
    { ok: true, user_id: created.user.id, email },
    { status: 201 }
  );
}
