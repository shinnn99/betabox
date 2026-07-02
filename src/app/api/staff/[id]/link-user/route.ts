import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function ensureStaff(staffId: string, orgId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("staff_profiles")
    .select("id, organization_id, user_id, staff_code, full_name, phone")
    .eq("id", staffId)
    .single();
  if (!data || data.organization_id !== orgId) return null;
  return data;
}

export async function POST(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("staff.invite");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const staff = await ensureStaff(id, ctx.organizationId);
  if (!staff) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const userId = body?.user_id as string | undefined;
  if (!userId) {
    return NextResponse.json({ error: "user_id_required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Kiểm tra user cùng org
  const { data: profile } = await admin
    .from("user_profiles")
    .select("id, organization_id, full_name")
    .eq("id", userId)
    .single();
  if (!profile || profile.organization_id !== ctx.organizationId) {
    return NextResponse.json({ error: "user_not_in_org" }, { status: 400 });
  }

  // Kiểm tra user chưa link với staff khác
  const { data: existing } = await admin
    .from("staff_profiles")
    .select("id, staff_code")
    .eq("organization_id", ctx.organizationId)
    .eq("user_id", userId)
    .neq("id", id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      {
        error: "user_already_linked",
        message: `Người dùng này đã liên kết với nhân viên ${existing.staff_code}.`,
      },
      { status: 400 }
    );
  }

  const { error } = await admin
    .from("staff_profiles")
    .update({ user_id: userId })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Đồng bộ: staff là chủ thông tin cá nhân — copy đè xuống user_profiles
  await admin
    .from("user_profiles")
    .update({ full_name: staff.full_name, phone: staff.phone })
    .eq("id", userId);

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "staff.link_user",
    targetType: "staff",
    targetId: id,
    metadata: {
      staff_code: staff.staff_code,
      linked_user_id: userId,
      linked_user_name: profile.full_name,
      synced: { full_name: staff.full_name, phone: staff.phone },
    },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("staff.invite");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const staff = await ensureStaff(id, ctx.organizationId);
  if (!staff) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!staff.user_id) {
    return NextResponse.json({ error: "not_linked" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("staff_profiles")
    .update({ user_id: null })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "staff.unlink_user",
    targetType: "staff",
    targetId: id,
    metadata: { staff_code: staff.staff_code, unlinked_user_id: staff.user_id },
  });

  return NextResponse.json({ ok: true });
}
