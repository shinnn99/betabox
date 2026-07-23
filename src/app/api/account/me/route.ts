import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

// ============================================================================
// /api/account/me — self-service profile cho user đang đăng nhập.
//
// Khác /api/users/[id]:
//   - Không yêu cầu permission "user.update" (viewer/packer cũng tự sửa được
//     họ tên + SĐT của chính mình).
//   - Email KHÔNG cho đổi (đổi email ảnh hưởng auth, phải flow xác thực khác).
//   - Nếu user đã linked staff → chặn sửa full_name/phone (nguồn chân lý ở
//     Nhân sự kho, tránh 2 nguồn lệch).
// ============================================================================

async function getCurrentUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
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

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles")
    .select("full_name, phone, organization_id, role")
    .eq("id", user.id)
    .maybeSingle();

  const orgId = profile?.organization_id ?? "";
  const linked = orgId ? await isLinkedToStaff(user.id, orgId) : false;

  return NextResponse.json({
    userId: user.id,
    email: user.email ?? "",
    fullName: profile?.full_name ?? "",
    phone: profile?.phone ?? null,
    role: profile?.role ?? null,
    organizationId: orgId,
    createdAt: user.created_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    linkedToStaff: linked,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles")
    .select("organization_id, full_name, phone")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }

  const linked = await isLinkedToStaff(user.id, profile.organization_id);
  if (linked) {
    return NextResponse.json(
      {
        error: "linked_to_staff",
        message:
          "Tài khoản đã liên kết với nhân viên kho — họ tên và SĐT sửa ở trang Nhân sự kho.",
      },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};

  if (typeof body.full_name === "string") {
    const trimmed = body.full_name.trim();
    if (trimmed.length < 2) {
      return NextResponse.json(
        { error: "invalid_name", message: "Họ tên tối thiểu 2 ký tự." },
        { status: 400 }
      );
    }
    update.full_name = trimmed;
  }

  if ("phone" in body) {
    if (body.phone === null || body.phone === "") {
      update.phone = null;
    } else if (typeof body.phone === "string") {
      const trimmed = body.phone.trim();
      // Chấp nhận số + dấu +/-/space, tối đa 20 ký tự
      if (!/^[+\d][\d\s-]{4,19}$/.test(trimmed)) {
        return NextResponse.json(
          {
            error: "invalid_phone",
            message: "Số điện thoại không hợp lệ.",
          },
          { status: 400 }
        );
      }
      update.phone = trimmed;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const { error: updErr } = await admin
    .from("user_profiles")
    .update(update)
    .eq("id", user.id);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 400 });
  }

  await audit({
    organizationId: profile.organization_id,
    actorUserId: user.id,
    actorEmail: user.email ?? undefined,
    action: "account.self_update",
    targetType: "user",
    targetId: user.id,
    metadata: {
      changes: update,
      previous: { full_name: profile.full_name, phone: profile.phone },
    },
  });

  return NextResponse.json({ ok: true });
}
