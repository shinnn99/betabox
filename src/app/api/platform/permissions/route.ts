import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole, invalidatePermissionCache } from "@/lib/supabase/guard";
import {
  ALWAYS_ON_PERMISSION_CODES,
  PERMISSION_DEFINITIONS,
  RBAC_ROLES,
  permissionDefinition,
} from "@/lib/rbac-catalog";
import type { Role } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLE_CODES = new Set<Role>(RBAC_ROLES.map((role) => role.code));

type MatrixRow = { role: Role; permission_code: string };

async function readMatrix() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("role_permission_matrix")
    .select("role, permission_code")
    .order("permission_code")
    .order("role");
  return { admin, rows: (data ?? []) as MatrixRow[], error };
}

function allDefinitions(rows: MatrixRow[]) {
  const known = new Set(PERMISSION_DEFINITIONS.map((permission) => permission.code));
  const unknown = [...new Set(rows.map((row) => row.permission_code))]
    .filter((code) => !known.has(code))
    .sort()
    .map(permissionDefinition);
  return [...PERMISSION_DEFINITIONS, ...unknown];
}

/** Đọc được với platform_support; chỉ platform_owner mới được lưu. */
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const { rows, error } = await readMatrix();
  if (error) {
    return NextResponse.json(
      { error: "permissions_unavailable", message: error.message },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      roles: RBAC_ROLES,
      permissions: allDefinitions(rows),
      grants: rows.map((row) => [row.role, row.permission_code]),
      canEdit: ctx.platformRole === "platform_owner",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Thay nguyên ma trận trong một transaction DB. Owner/admin luôn full quyền
 * và bị khóa trên UI + server để không thể tự cắt đường khôi phục hệ thống.
 */
export async function PUT(req: Request) {
  const ctx = await requirePlatformRole("platform_owner");
  if (ctx instanceof NextResponse) return ctx;

  const body = (await req.json().catch(() => null)) as
    | { permissions?: Record<string, unknown> }
    | null;
  if (!body?.permissions || typeof body.permissions !== "object") {
    return NextResponse.json(
      { error: "invalid_body", message: "Thiếu ma trận quyền cần lưu." },
      { status: 400 },
    );
  }

  const { admin, rows, error } = await readMatrix();
  if (error) {
    return NextResponse.json(
      { error: "permissions_unavailable", message: error.message },
      { status: 503 },
    );
  }

  const definitions = allDefinitions(rows);
  const validCodes = new Set(definitions.map((permission) => permission.code));
  const normalized = {} as Record<Role, string[]>;

  for (const role of RBAC_ROLES) {
    const requested = body.permissions[role.code];
    if (!Array.isArray(requested) || requested.some((code) => typeof code !== "string")) {
      return NextResponse.json(
        { error: "invalid_role_permissions", message: `Quyền của ${role.label} không hợp lệ.` },
        { status: 400 },
      );
    }
    const codes = [...new Set(requested as string[])];
    const invalid = codes.filter((code) => !validCodes.has(code));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: "unknown_permission", message: `Mã quyền không hợp lệ: ${invalid.join(", ")}` },
        { status: 400 },
      );
    }
    // Quyền luôn-bật (xem/tải video) được ép vào mọi vai trò dù client gửi gì.
    normalized[role.code] = role.lockedFullAccess
      ? [...validCodes].sort()
      : [...new Set([...codes, ...ALWAYS_ON_PERMISSION_CODES])].sort();
  }

  const extraRoles = Object.keys(body.permissions).filter(
    (role) => !ROLE_CODES.has(role as Role),
  );
  if (extraRoles.length > 0) {
    return NextResponse.json(
      { error: "unknown_role", message: `Vai trò không hợp lệ: ${extraRoles.join(", ")}` },
      { status: 400 },
    );
  }

  const before = new Set(rows.map((row) => `${row.role}:${row.permission_code}`));
  const after = new Set(
    RBAC_ROLES.flatMap((role) =>
      normalized[role.code].map((permission) => `${role.code}:${permission}`),
    ),
  );
  const added = [...after].filter((grant) => !before.has(grant));
  const removed = [...before].filter((grant) => !after.has(grant));

  const { error: replaceError } = await admin.rpc("replace_role_permission_matrix", {
    p_matrix: normalized,
    p_actor_user_id: ctx.userId,
    p_actor_email: ctx.email,
    p_actor_role: ctx.platformRole,
    p_metadata: {
      added_count: added.length,
      removed_count: removed.length,
      added: added.slice(0, 200),
      removed: removed.slice(0, 200),
    },
  });
  if (replaceError) {
    return NextResponse.json(
      { error: "save_failed", message: replaceError.message },
      { status: 500 },
    );
  }

  // Ma trận quyền được đệm 60 giây trong guard.ts — xoá ngay trên process
  // hiện tại. Nếu sau này chạy nhiều process, process khác chậm tối đa một TTL.
  invalidatePermissionCache();

  return NextResponse.json({ ok: true, added: added.length, removed: removed.length });
}
