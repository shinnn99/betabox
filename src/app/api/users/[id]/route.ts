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

type UserStatus = "active" | "disabled";
const VALID_STATUS: UserStatus[] = ["active", "disabled"];

/**
 * Khoá/mở tài khoản ở TẦNG XÁC THỰC, không chỉ trong `user_profiles`.
 *
 * `user_profiles.status` là cột của riêng ứng dụng — Supabase Auth không biết
 * nó tồn tại. Đặt `status='disabled'` mà không làm gì thêm thì
 * `signInWithPassword` vẫn cấp token bình thường: người bị khoá đăng nhập
 * được, và mọi route dùng `requirePermission` (không-strict) vẫn phục vụ họ
 * vì guard đó đọc vai trò từ JWT chứ không hỏi lại DB.
 *
 * `banned_until` là thứ DUY NHẤT Supabase Auth thực sự chặn ở cửa đăng nhập.
 * Đặt qua `ban_duration`: "876000h" là 100 năm — khoá vô hạn do người quản trị
 * quyết định, không phải hình phạt tạm. Mở khoá là "none".
 *
 * Best-effort có chủ đích: hồ sơ trong `user_profiles` đã ghi xong là nguồn
 * sự thật của ứng dụng, và `requirePermissionStrict` đã chặn dựa trên đó.
 * Auth hỏng thì báo cho admin biết để còn xử, nhưng không rollback nghiệp vụ
 * chính rồi để admin tưởng lệnh khoá thất bại hoàn toàn.
 */
async function syncAuthBan(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  status: UserStatus,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: status === "disabled" ? "876000h" : "none",
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

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
  const ctx = await requirePermissionStrict("user.update", req);
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
  if (typeof body.status === "string") {
    if (!VALID_STATUS.includes(body.status as UserStatus)) {
      return NextResponse.json(
        { error: "invalid_status", message: "Trạng thái không hợp lệ." },
        { status: 400 },
      );
    }
    update.status = body.status;
  }
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

  // Đổi status thì PHẢI kéo theo tầng xác thực, nếu không "disabled" chỉ là
  // một chữ trong bảng: người bị khoá vẫn đăng nhập được như thường.
  let authBanWarning: string | null = null;
  if (typeof update.status === "string") {
    const status = update.status as UserStatus;
    const banned = await syncAuthBan(admin, id, status);
    if (!banned.ok) {
      authBanWarning = banned.message ?? "không rõ nguyên nhân";
      console.error(
        `[user.update] khoá/mở tài khoản ở tầng auth THẤT BẠI user=${id} status=${status} message=${authBanWarning}`,
      );
    }

    // Khoá mà phiên đang mở vẫn chạy thì chưa đóng được cửa. GoTrue tự thu
    // hồi refresh token khi ban, nhưng access token đã phát thì sống tới hết
    // hạn (mặc định 1 giờ) — và route dùng `requirePermission` (không strict)
    // đọc vai trò từ chính token đó nên không biết chủ nhân vừa bị khoá.
    // Xoá thẳng phiên trong auth.sessions để không phải chờ hết giờ.
    if (status === "disabled") {
      const { error: sessErr } = await admin.rpc("revoke_user_sessions", {
        p_user_id: id,
      });
      if (sessErr) {
        console.error(
          `[user.update] huỷ phiên đăng nhập THẤT BẠI user=${id} message=${sessErr.message}`,
        );
        authBanWarning ??= sessErr.message;
      }
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
      ...(authBanWarning ? { auth_ban_failed: authBanWarning } : {}),
    },
  });

  // Hồ sơ đã đổi nhưng tầng xác thực chưa theo: PHẢI nói ra. Im lặng ở đây
  // nghĩa là admin đóng màn hình với niềm tin đã khoá xong, trong khi người
  // kia vẫn đăng nhập được — đúng cảnh vừa xảy ra ngày 25/09/2026.
  if (authBanWarning) {
    return NextResponse.json({
      ok: true,
      warning: "auth_ban_failed",
      message:
        "Đã đổi trạng thái trong hồ sơ, nhưng KHOÁ Ở TẦNG ĐĂNG NHẬP THẤT BẠI — " +
        "người này có thể vẫn đăng nhập được. Hãy báo kỹ thuật ngay.",
    });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("user.delete", req);
  if (isError(ctx)) return ctx;
  const { id } = await params;

  // Chốt thứ hai, độc lập với bảng quyền: CHỈ chủ sở hữu được xoá tài khoản
  // (chủ dự án chốt 23/09/2026). Xoá là mất sạch hồ sơ khỏi database, không
  // hoàn tác được — một dòng cấp nhầm trong role_permission_matrix không
  // được phép mở cánh cửa này.
  if (ctx.role !== "owner") {
    return NextResponse.json(
      {
        error: "owner_only",
        message: "Chỉ chủ sở hữu mới được xoá tài khoản người dùng.",
      },
      { status: 403 },
    );
  }

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

  // try/catch bao ngoài: deleteUser có thể THROW (không chỉ trả error) khi
  // Postgres từ chối hoặc mạng đứt. Không bắt thì Next trả 500 với body khác
  // hẳn hợp đồng { error, message }, client hiện toast rỗng.
  try {
    // Xoá THẬT: tài khoản đăng nhập đi trước, hồ sơ trong user_profiles theo
    // sau bằng khoá ngoại ON DELETE CASCADE. Dòng delete bên dưới là lưới an
    // toàn cho hai ca hiếm: cascade bị gỡ, hoặc hồ sơ mồ côi (tài khoản đăng
    // nhập đã mất từ trước nên deleteUser báo not found).
    const { error } = await admin.auth.admin.deleteUser(id);
    const authUserMissing =
      !!error && /not.?found/i.test(`${error.message} ${(error as { code?: string }).code ?? ""}`);
    if (error && !authUserMissing) {
      throw error;
    }

    const { error: profileError } = await admin
      .from("user_profiles")
      .delete()
      .eq("id", id)
      .eq("organization_id", ctx.organizationId);
    if (profileError) {
      throw profileError;
    }
  } catch (err) {
    // `message` của Error là non-enumerable — đọc ra chuỗi TRƯỚC khi đưa vào
    // JSON, nếu không nó rụng mất và client chỉ nhận {name, status, code}.
    const raw = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? "";

    // Khoá ngoại chặn: còn bảng nào đó tham chiếu tài khoản này. Sau migration
    // 20260925100000 thì camera_recording_sessions và order_proof_clips đã
    // SET NULL, nên nhánh này chỉ còn bắt bảng mới thêm sau mà quên đặt quy tắc
    // xoá — báo đúng bản chất thay vì ném text Postgres vào mặt người dùng.
    const isFkViolation = code === "23503" || /foreign key|violates/i.test(raw);
    if (isFkViolation) {
      console.error(
        `[user.delete] FK chặn xoá user=${id} org=${ctx.organizationId} code=${code} message=${raw}`,
      );
      return NextResponse.json(
        {
          error: "user_has_references",
          message:
            "Không xoá được tài khoản vì còn dữ liệu đang tham chiếu tới. Hãy khoá tài khoản thay vì xoá, và báo kỹ thuật.",
        },
        { status: 409 },
      );
    }

    console.error(
      `[user.delete] thất bại user=${id} org=${ctx.organizationId} code=${code} message=${raw}`,
    );
    return NextResponse.json(
      { error: "delete_failed", message: `Xoá tài khoản thất bại: ${raw}` },
      { status: 400 },
    );
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
