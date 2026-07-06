import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "./server";
import { createAdminClient } from "./admin";
import { verifyOrgContext } from "@/lib/platform/internal-headers";
import { checkPlatformAdmin, type PlatformRole } from "@/lib/platform/admin-check";
import type { Role } from "@/lib/auth";

const INTERNAL_ORG_CTX_HEADER = "x-internal-org-ctx";
const RENDER_ORG_ID_HEADER = "x-render-org-id";

// ============================================================================
// checkRenderOrgMatch — Vế 4: đóng cửa sổ ghi-nhầm về 0.
//
// Header-tín-hiệu: client wrapper gửi `x-render-org-id` CHỈ cho POST/PUT/DELETE
// (đọc từ data-render-org-id nhúng server-side khi render trang). Guard đọc
// header — có → so vs ctx.organizationId (org-sau-verify-token, cái sắp ghi);
// không → GET/read, bỏ qua.
//
// Cửa sổ 2-tab (tab A render org X, tab B đổi cookie sang Y, tab A submit trước
// khi reload): request mang x-render-org-id=X + cookie/token=Y → guard so
// X vs Y → lệch → 409. Không ghi vào Y. Cửa sổ đóng tại server, không phụ
// thuộc client kịp reload hay không.
//
// Lỗ khi header vắng (client không dùng wrapper, hoặc wrapper bug): rơi vào
// non-write hoặc bỏ qua so — hở cửa sổ. Chấp nhận vì:
//   1. Wrapper là MỘT chỗ (api-fetch.tsx), test được.
//   2. Guard vẫn verify token → tenant không phải platform-admin không tới đây.
//   3. Vế 4 chống NHẦM-TAY, không chống tấn công (token gate chống tấn công).
// ============================================================================
function checkRenderOrgMatch(
  ctx: ApiContext,
  renderOrgId: string | null
): NextResponse | null {
  if (!renderOrgId) return null; // Không header → GET, bỏ qua
  if (renderOrgId === ctx.organizationId) return null; // Khớp → OK
  return NextResponse.json(
    {
      error: "org_context_changed",
      message: "Tổ chức đang xem đã đổi ở tab khác. Vui lòng tải lại trang.",
    },
    { status: 409 }
  );
}

export interface ApiContext {
  userId: string;
  email: string;
  organizationId: string;
  role: Role;
  // Field mở rộng platform — default false cho tenant, 51 route hiện tại đọc
  // organizationId/role không đổi behavior.
  isPlatform: boolean;
  platformRole?: PlatformRole;
  impersonatingOrgId?: string;
}

// ============================================================================
// readJwtClaims — Lớp A. Không đổi ngữ nghĩa so với readClaims cũ.
// ============================================================================
async function readJwtClaims(): Promise<
  | { userId: string; email: string; organizationId: string; role: Role }
  | NextResponse
> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const claims = data.claims as Record<string, unknown>;
  return {
    userId: claims.sub as string,
    email: (claims.email as string) ?? "",
    organizationId: (claims.organization_id as string) ?? "",
    role: (claims.user_role as Role) ?? "viewer",
  };
}

// ============================================================================
// resolveTenant — MỘT NGUỒN cho "đường tenant xử thế nào".
// Gọi từ 2 chỗ: (1) không token (tenant thường), (2) có token nhưng
// platform=null (tenant có token bất thường, đã log warning trước).
// Cả 2 dùng cùng logic: có org → return ctx; không org → 403.
// Không lặp check `!organizationId` ở nhiều chỗ.
// ============================================================================
function resolveTenant(jwt: {
  userId: string;
  email: string;
  organizationId: string;
  role: Role;
}): ApiContext | NextResponse {
  if (!jwt.organizationId) {
    return NextResponse.json(
      { error: "no_organization", message: "User chưa được gán organization." },
      { status: 403 }
    );
  }
  return { ...jwt, isPlatform: false };
}

// ============================================================================
// readClaims — 3 lớp thẳng, dấu hiệu-trước, mỗi nhánh tự đủ.
//
// Ba nhánh (đọc-diff thấy ngay):
//   1. Không token → resolveTenant(jwt) — tenant thường (99% hot path).
//   2. Có token + platform=null → log warn + resolveTenant(jwt) — tenant có
//      token bất thường (bỏ token, đường tenant, tránh oracle leak).
//   3. Có token + platform=true → verify token → org từ token → platform ctx.
//
// Header đọc 1 lần. `!organizationId` check 1 chỗ (resolveTenant).
// Nhánh platform KHÔNG đụng jwt.organizationId (org từ token).
// Lớp B (checkPlatformAdmin) gate trước lớp C (verifyOrgContext) —
// tenant giả token vô hại (dừng ở B, không tới C).
// ============================================================================
async function readClaims(): Promise<ApiContext | NextResponse> {
  // LỚP A: JWT
  const jwt = await readJwtClaims();
  if (jwt instanceof NextResponse) return jwt;

  // Đọc header MỘT LẦN — dấu hiệu platform + render-org-id (vế 4)
  const h = await headers();
  const token = h.get(INTERNAL_ORG_CTX_HEADER);
  const renderOrgId = h.get(RENDER_ORG_ID_HEADER);

  // ═══════ NHÁNH TENANT (không dấu hiệu platform) ═══════
  if (!token) {
    const ctx = resolveTenant(jwt);
    if (ctx instanceof NextResponse) return ctx;
    // Vế 4: header-tín-hiệu — có x-render-org-id nghĩa là request GHI
    // (client wrapper chỉ gửi cho POST/PUT/DELETE) → so vs ctx.organizationId
    const mismatch = checkRenderOrgMatch(ctx, renderOrgId);
    if (mismatch) return mismatch;
    return ctx;
  }

  // ═══════ CÓ TOKEN — LỚP B: check platform_admins ═══════
  const platform = await checkPlatformAdmin(jwt.userId);

  if (!platform) {
    console.warn("[guard] non-platform user has org-context token", {
      userId: jwt.userId,
      email: jwt.email,
    });
    const ctx = resolveTenant(jwt);
    if (ctx instanceof NextResponse) return ctx;
    // Vế 4 áp cho nhánh này (tenant có token bất thường → bỏ token, đường tenant)
    const mismatch = checkRenderOrgMatch(ctx, renderOrgId);
    if (mismatch) return mismatch;
    return ctx;
  }

  // ═══════ LỚP B=true (PLATFORM ADMIN) — LỚP C: verify token ═══════
  const verify = await verifyOrgContext(token);

  if (!verify.valid) {
    if (verify.reason === "expired") {
      console.info("[guard] org-context expired, prompting re-navigate", {
        userId: jwt.userId,
      });
      return NextResponse.json(
        {
          error: "org_context_expired",
          message: "Phiên xem tổ chức hết hạn, tải lại trang.",
        },
        { status: 401 }
      );
    }
    console.error(
      "[guard] platform admin has malformed/invalid org-context token",
      { userId: jwt.userId, reason: verify.reason }
    );
    return NextResponse.json(
      { error: "invalid_org_context" },
      { status: 403 }
    );
  }

  // Validate org tồn tại
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("id", verify.orgId)
    .maybeSingle();
  if (!org) {
    return NextResponse.json(
      {
        error: "org_not_found",
        message: "Tổ chức impersonate không tồn tại.",
      },
      { status: 404 }
    );
  }

  const ctx: ApiContext = {
    userId: jwt.userId,
    email: jwt.email,
    organizationId: verify.orgId, // ← TỪ TOKEN, không JWT
    role: "owner", // ← Platform impersonate như owner ảo (Q3.3 chốt)
    isPlatform: true,
    platformRole: platform.platformRole,
    impersonatingOrgId: verify.orgId,
  };

  // ═══════ VẾ 4: so x-render-org-id vs org-TRONG-TOKEN (ctx.organizationId) ═══
  // Đặt SAU verifyOrgContext (ctx.organizationId = verify.orgId, org đã-verify
  // độc-lập-cookie). Client wrapper gửi header CHỈ cho POST/PUT/DELETE →
  // header có mặt = tín hiệu ghi. Lệch → 409, đóng cửa sổ ghi-nhầm.
  const mismatch = checkRenderOrgMatch(ctx, renderOrgId);
  if (mismatch) return mismatch;

  return ctx;
}

// ============================================================================
// requirePermission — SIGNATURE KHÔNG ĐỔI (backward-compat 51 route)
// Non-strict: đọc role từ JWT claim, nhanh, chấp nhận token cũ vài phút.
// ============================================================================
export async function requirePermission(
  permission: string
): Promise<ApiContext | NextResponse> {
  const ctx = await readClaims();
  if (ctx instanceof NextResponse) return ctx;

  // Platform bypass matrix tenant (Q3.3 — full quyền impersonate)
  if (ctx.isPlatform) return ctx;

  // Logic tenant CŨ giữ nguyên
  if (!(await checkPermission(ctx.role, permission))) {
    return NextResponse.json(
      { error: "forbidden", permission },
      { status: 403 }
    );
  }
  return ctx;
}

// ============================================================================
// requirePermissionStrict — SIGNATURE KHÔNG ĐỔI (backward-compat)
// Strict: re-check role từ DB. Dùng cho create/update/delete nhạy.
// ============================================================================
export async function requirePermissionStrict(
  permission: string
): Promise<ApiContext | NextResponse> {
  const ctx = await readClaims();
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.isPlatform) return ctx; // Platform bypass strict cũng

  // Logic tenant CŨ giữ nguyên (re-check role từ DB)
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
    return NextResponse.json(
      { error: "forbidden", permission },
      { status: 403 }
    );
  }
  return { ...ctx, role: realRole };
}

// ============================================================================
// requirePlatformRole — HÀM MỚI cho route /platform/*
// Route platform admin (dashboard SaaS, list org, add admin) dùng hàm này,
// KHÔNG requirePermission* (platform admin không có organization_id trong JWT).
// ============================================================================
export async function requirePlatformRole(
  minRole: PlatformRole = "platform_support"
): Promise<
  | { userId: string; email: string; platformRole: PlatformRole }
  | NextResponse
> {
  const jwt = await readJwtClaims();
  if (jwt instanceof NextResponse) return jwt;

  const platform = await checkPlatformAdmin(jwt.userId);
  if (!platform) {
    return NextResponse.json(
      { error: "forbidden_platform_only" },
      { status: 403 }
    );
  }

  // Role hierarchy: platform_owner > platform_support
  const rank: Record<PlatformRole, number> = {
    platform_support: 1,
    platform_owner: 2,
  };
  if (rank[platform.platformRole] < rank[minRole]) {
    return NextResponse.json(
      { error: "forbidden_role", required: minRole },
      { status: 403 }
    );
  }

  return {
    userId: jwt.userId,
    email: jwt.email,
    platformRole: platform.platformRole,
  };
}

// ============================================================================
// checkPermission — KHÔNG ĐỔI (query role_permission_matrix)
// ============================================================================
async function checkPermission(
  role: Role,
  permission: string
): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("role_permission_matrix")
    .select("permission_code")
    .eq("role", role)
    .eq("permission_code", permission)
    .maybeSingle();
  return !!data;
}

// ============================================================================
// isError — KHÔNG ĐỔI
// ============================================================================
export function isError(x: ApiContext | NextResponse): x is NextResponse {
  return x instanceof NextResponse;
}
