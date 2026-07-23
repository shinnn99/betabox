import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";
import { canAssignRole, type Role } from "@/lib/auth";

const VALID_ROLES: Role[] = [
  "owner",
  "admin",
  "warehouse_manager",
  "shift_leader",
  "packer",
  "viewer",
];

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function fetchTargetProfile(userId: string, orgId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_profiles")
    .select("id, organization_id, role, status, full_name")
    .eq("id", userId)
    .single();
  if (!data || data.organization_id !== orgId) return null;
  return data;
}

async function isLinkedToStaff(userId: string, orgId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("staff_profiles")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function countActiveOwners(orgId: string): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.rpc("count_active_owners_app", { p_org_id: orgId });
  if (typeof data === "number") return data;
  // Fallback: query trực tiếp
  const { count } = await admin
    .from("user_profiles")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("role", "owner")
    .eq("status", "active");
  return count ?? 0;
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("user.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const target = await fetchTargetProfile(id, ctx.organizationId);
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const linked = await isLinkedToStaff(id, ctx.organizationId);

  if (linked && (typeof body.full_name === "string" || "phone" in body)) {
    return NextResponse.json(
      {
        error: "linked_to_staff",
        message:
          "User này đã liên kết với nhân viên kho — họ tên và SĐT phải sửa ở trang Nhân sự kho.",
      },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  if (typeof body.full_name === "string") update.full_name = body.full_name.trim();
  if (typeof body.phone === "string" || body.phone === null) update.phone = body.phone;
  if (typeof body.status === "string") update.status = body.status;
  if (typeof body.role === "string") {
    if (!VALID_ROLES.includes(body.role as Role)) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
    update.role = body.role;
  }

  // Chống leo thang: actor không được động target rank >= mình (trừ owner),
  // và cũng không được set target sang role rank >= mình. Hai vế riêng:
  //   - Vế 1 (target hiện tại): admin không được sửa owner/admin khác.
  //   - Vế 2 (role mới nếu đổi): admin không được nâng ai lên admin/owner.
  if (!canAssignRole(ctx.role, target.role as Role)) {
    return NextResponse.json(
      {
        error: "forbidden_role_escalation",
        message: `Bạn (${ctx.role}) không được phép sửa tài khoản vai trò ${target.role}.`,
      },
      { status: 403 }
    );
  }
  if (typeof update.role === "string" && !canAssignRole(ctx.role, update.role as Role)) {
    return NextResponse.json(
      {
        error: "forbidden_role_escalation",
        message: `Bạn (${ctx.role}) không được phép gán vai trò ${update.role}.`,
      },
      { status: 403 }
    );
  }

  // (3) Chặn hạ role / disable owner cuối cùng
  const isDemotingOwner =
    target.role === "owner" &&
    ((typeof update.role === "string" && update.role !== "owner") ||
      (typeof update.status === "string" && update.status !== "active"));
  if (isDemotingOwner) {
    const owners = await countActiveOwners(ctx.organizationId);
    if (owners <= 1) {
      return NextResponse.json(
        {
          error: "last_owner",
          message: "Không thể hạ quyền hoặc khoá chủ sở hữu cuối cùng của tổ chức.",
        },
        { status: 400 }
      );
    }
  }

  const admin = createAdminClient();

  if (Object.keys(update).length > 0) {
    const { error: profileErr } = await admin
      .from("user_profiles")
      .update(update)
      .eq("id", id)
      .eq("organization_id", ctx.organizationId);
    if (profileErr) {
      return NextResponse.json({ error: profileErr.message }, { status: 400 });
    }
  }

  let passwordChanged = false;
  if (typeof body.password === "string" && body.password.length >= 8) {
    const { error: pwErr } = await admin.auth.admin.updateUserById(id, {
      password: body.password,
    });
    if (pwErr) {
      return NextResponse.json({ error: pwErr.message }, { status: 400 });
    }
    passwordChanged = true;
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: passwordChanged ? "user.update+password" : "user.update",
    targetType: "user",
    targetId: id,
    metadata: {
      changes: update,
      password_changed: passwordChanged,
      previous_role: target.role,
    },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("user.delete");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  if (id === ctx.userId) {
    return NextResponse.json(
      { error: "self_delete_forbidden", message: "Không thể tự xoá tài khoản mình." },
      { status: 400 }
    );
  }

  const target = await fetchTargetProfile(id, ctx.organizationId);
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Chống leo thang: actor không được xoá target rank >= mình (trừ owner).
  // Admin không được xoá owner/admin khác.
  if (!canAssignRole(ctx.role, target.role as Role)) {
    return NextResponse.json(
      {
        error: "forbidden_role_escalation",
        message: `Bạn (${ctx.role}) không được phép xoá tài khoản vai trò ${target.role}.`,
      },
      { status: 403 }
    );
  }

  // (3) Chặn xoá owner cuối cùng
  if (target.role === "owner") {
    const owners = await countActiveOwners(ctx.organizationId);
    if (owners <= 1) {
      return NextResponse.json(
        {
          error: "last_owner",
          message: "Không thể xoá chủ sở hữu cuối cùng của tổ chức.",
        },
        { status: 400 }
      );
    }
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "user.delete",
    targetType: "user",
    targetId: id,
    metadata: { full_name: target.full_name, role: target.role },
  });

  return NextResponse.json({ ok: true });
}
