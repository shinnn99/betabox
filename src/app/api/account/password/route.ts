import { NextResponse } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

// Rate-limit brute-force old_password: đếm audit row password_fail của cùng
// user trong 5 phút gần đây. Ngưỡng 5 = đủ cho user gõ nhầm vài lần, chặn
// script thử password. Blast radius ban đầu thấp (cần cookie hợp lệ mới tới
// endpoint này), nhưng nếu attacker đã có cookie thì đây là cửa cuối chống
// leo thang confirm bằng old_password.
const PASSWORD_FAIL_WINDOW_MIN = 5;
const PASSWORD_FAIL_THRESHOLD = 5;

// ============================================================================
// /api/account/password — user tự đổi mật khẩu.
//
// Verify mật khẩu cũ bằng cách signInWithPassword ở client Supabase riêng
// (không đụng cookie session của user hiện tại). Nếu OK → dùng admin client
// cập nhật password. Không dùng supabase.auth.updateUser trên server-cookie
// client vì nó có thể quay vòng session và làm hỏng cookie hiện tại.
// ============================================================================

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = userData.user;
  if (!user.email) {
    return NextResponse.json({ error: "no_email" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const oldPassword = typeof body.old_password === "string" ? body.old_password : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";

  if (!oldPassword) {
    return NextResponse.json(
      { error: "missing_old_password", message: "Vui lòng nhập mật khẩu hiện tại." },
      { status: 400 }
    );
  }
  if (newPassword.length < 8) {
    return NextResponse.json(
      {
        error: "weak_password",
        message: "Mật khẩu mới cần tối thiểu 8 ký tự.",
      },
      { status: 400 }
    );
  }
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return NextResponse.json(
      {
        error: "weak_password",
        message: "Mật khẩu mới cần gồm cả chữ và số.",
      },
      { status: 400 }
    );
  }
  if (oldPassword === newPassword) {
    return NextResponse.json(
      {
        error: "same_password",
        message: "Mật khẩu mới không được trùng mật khẩu hiện tại.",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Rate-limit TRƯỚC khi verify — chặn brute-force sớm, không tốn 1 signIn
  // request tới GoTrue cho mỗi lần thử. Đếm row password_fail cùng user
  // trong PASSWORD_FAIL_WINDOW_MIN phút.
  const windowStart = new Date(
    Date.now() - PASSWORD_FAIL_WINDOW_MIN * 60 * 1000,
  ).toISOString();
  const { count: failCount } = await admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("actor_user_id", user.id)
    .eq("action", "account.password_fail")
    .gte("created_at", windowStart);
  if ((failCount ?? 0) >= PASSWORD_FAIL_THRESHOLD) {
    return NextResponse.json(
      {
        error: "too_many_attempts",
        message: `Quá ${PASSWORD_FAIL_THRESHOLD} lần sai mật khẩu trong ${PASSWORD_FAIL_WINDOW_MIN} phút. Vui lòng thử lại sau.`,
      },
      { status: 429 },
    );
  }

  // Verify old password bằng client tạm (không cookie), tránh đụng session
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const tmp = createSbClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await tmp.auth.signInWithPassword({
    email: user.email,
    password: oldPassword,
  });
  // Lấy org 1 lần dùng cho cả nhánh fail (audit password_fail) + nhánh
  // success (audit change_password).
  const { data: profile } = await admin
    .from("user_profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();

  if (signInErr) {
    // Ghi audit row để rate-limit đếm. Nếu profile không có org (ca cạnh:
    // user đã bị unlink) → skip audit, rate-limit không đếm ca này. Chấp
    // nhận vì brute-force khả thi cần user login được, mà login được thì
    // profile phải có.
    if (profile?.organization_id) {
      await audit({
        organizationId: profile.organization_id,
        actorUserId: user.id,
        actorEmail: user.email,
        action: "account.password_fail",
        targetType: "user",
        targetId: user.id,
        metadata: { self: true },
      });
    }
    return NextResponse.json(
      {
        error: "wrong_old_password",
        message: "Mật khẩu hiện tại không đúng.",
      },
      { status: 400 }
    );
  }
  const { error: updErr } = await admin.auth.admin.updateUserById(user.id, {
    password: newPassword,
  });
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 400 });
  }

  if (profile?.organization_id) {
    await audit({
      organizationId: profile.organization_id,
      actorUserId: user.id,
      actorEmail: user.email ?? undefined,
      action: "account.change_password",
      targetType: "user",
      targetId: user.id,
      metadata: { self: true },
    });
  }

  return NextResponse.json({ ok: true });
}
