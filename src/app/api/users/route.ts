import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { getScopedClient } from "@/lib/supabase/scoped-client";
import { audit } from "@/lib/audit";
import type { Role } from "@/lib/auth";

const VALID_ROLES: Role[] = [
  "owner",
  "admin",
  "warehouse_manager",
  "shift_leader",
  "packer",
  "viewer",
];

export async function GET() {
  const ctx = await requirePermission("user.view");
  if (isError(ctx)) return ctx;

  const scoped = await getScopedClient(ctx);
  const { data, error } = await scoped
    .select<{
      id: string;
      full_name: string;
      phone: string | null;
      role: Role;
      status: string;
      created_at: string;
    }>("user_profiles", "id, full_name, phone, role, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const admin = createAdminClient();
  const ids = (data ?? []).map((u) => u.id);
  const emails = new Map<string, string>();
  const linkedStaff = new Map<string, { id: string; staff_code: string; full_name: string }>();
  if (ids.length > 0) {
    await Promise.all(
      ids.map(async (id) => {
        const { data: au } = await admin.auth.admin.getUserById(id);
        if (au?.user?.email) emails.set(id, au.user.email);
      })
    );

    const { data: staff } = await admin
      .from("staff_profiles")
      .select("id, user_id, staff_code, full_name")
      .in("user_id", ids);
    for (const s of staff ?? []) {
      if (s.user_id) {
        linkedStaff.set(s.user_id, {
          id: s.id,
          staff_code: s.staff_code,
          full_name: s.full_name,
        });
      }
    }
  }

  const users = (data ?? []).map((u) => ({
    ...u,
    email: emails.get(u.id) ?? "",
    linked_staff: linkedStaff.get(u.id) ?? null,
  }));

  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const ctx = await requirePermissionStrict("user.create");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.full_name ?? "").trim();
  const phone = body.phone ? String(body.phone).trim() : null;
  const role = body.role as Role;

  if (!email || !password || password.length < 8 || !fullName || !VALID_ROLES.includes(role)) {
    return NextResponse.json(
      { error: "validation", message: "Email, mật khẩu (>=8 ký tự), họ tên và vai trò hợp lệ là bắt buộc." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

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

  const { error: profileErr } = await admin.from("user_profiles").insert({
    id: created.user.id,
    organization_id: ctx.organizationId,
    role,
    full_name: fullName,
    phone,
  });

  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: profileErr.message }, { status: 400 });
  }

  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorEmail: ctx.email,
    action: "user.create",
    targetType: "user",
    targetId: created.user.id,
    metadata: { email, role, full_name: fullName },
  });

  return NextResponse.json({ id: created.user.id, email }, { status: 201 });
}
