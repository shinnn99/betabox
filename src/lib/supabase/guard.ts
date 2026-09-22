import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "./server";
import { createAdminClient } from "./admin";
import { verifyOrgContext } from "@/lib/platform/internal-headers";
import { checkPlatformAdmin, type PlatformRole } from "@/lib/platform/admin-check";
import { evaluateRenderOrg } from "./render-org-guard";
import type { Role } from "@/lib/auth";

const INTERNAL_ORG_CTX_HEADER = "x-internal-org-ctx";
const RENDER_ORG_ID_HEADER = "x-render-org-id";

// ============================================================================
// checkRenderOrgMatch — Vế 4: đóng cửa sổ ghi-nhầm về 0.
//
// Client wrapper `apiFetch` gắn `x-render-org-id` cho mọi request GHI (đọc từ
// data-render-org-id mà layout dashboard nhúng server-side). Guard so nó với
// ctx.organizationId — org-sau-verify-token, tức org SẮP BỊ GHI VÀO.
//
// Cửa sổ 2-tab (tab A render org X, tab B đổi cookie sang Y, tab A submit trước
// khi reload): request mang x-render-org-id=X + cookie/token=Y → lệch → 409.
// Không ghi vào Y. Cửa sổ đóng tại server, không phụ thuộc client kịp reload.
//
// ── 2026-09-16: chuyển fail-OPEN → fail-CLOSED ──────────────────────────────
// Bản cũ bỏ qua kiểm tra khi header vắng, với lý do "vắng header nghĩa là GET".
// Suy luận đó dùng chính thứ cần chứng minh làm bằng chứng: header vắng cũng có
// thể là một request GHI từ client không dùng wrapper — và rà soát cho thấy
// 41/49 điểm ghi trong dashboard gọi `fetch` trần.
//
// Nó đã cắn: 2026-09-16 03:20, tab mở sẵn org Đại Kim nhận thao tác nhắm vào
// org Demo. PUT /api/cameras/{id} không kèm header → guard cho qua → camera
// `dahua_01` của kho thật bị ghi đè 8 trường, kho mất ghi hình ~24 giờ.
//
// Giờ method là tham số tường minh (không suy từ sự có mặt của header), và
// request GHI thiếu header bị CHẶN. Đánh đổi: mọi client ghi buộc phải đi qua
// `apiFetch`; quên thì vỡ ngay lúc dev thay vì im lặng ghi nhầm org khách.
//
// Quyết định thuần nằm ở `evaluateRenderOrg` (render-org-guard.ts) để test
// được không cần server — xem tests/render-org-guard.test.ts.
// ============================================================================
function checkRenderOrgMatch(
  ctx: ApiContext,
  method: string | null,
  renderOrgId: string | null
): NextResponse | null {
  const verdict = evaluateRenderOrg(method, renderOrgId, ctx.organizationId);

  switch (verdict.kind) {
    case "skip":
    case "allow":
      return null;

    case "mismatch":
      return NextResponse.json(
        {
          error: "org_context_changed",
          message:
            "Tổ chức đang xem đã đổi ở tab khác. Vui lòng tải lại trang.",
        },
        { status: 409 }
      );

    case "missing":
      // Không phải lỗi người dùng — là client gọi `fetch` trần thay vì
      // `apiFetch`. Log đủ để tìm ra đường gọi còn sót; trả cùng mã 409 để
      // wrapper tự reload (nếu sau này được sửa đúng) thay vì hiện lỗi lạ.
      console.error("[guard] write request thiếu x-render-org-id", {
        method,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
      });
      return NextResponse.json(
        {
          error: "org_context_missing",
          message:
            "Không xác định được tổ chức của trang. Vui lòng tải lại trang.",
        },
        { status: 409 }
      );
  }
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

/** Return the packing station assigned to the currently authenticated user. */
export async function getCurrentUserStation(): Promise<{
  id: string;
  name: string;
} | null> {
  // Chỉ đọc (select) — không phải request ghi, nên method = null → vế 4 skip.
  const ctx = await readClaims(null);
  if (ctx instanceof NextResponse) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_profiles")
    .select("station_id, packing_stations(id, name)")
    .eq("id", ctx.userId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  const station = Array.isArray(data?.packing_stations)
    ? data.packing_stations[0]
    : data?.packing_stations;
  return station?.id && station?.name ? { id: station.id, name: station.name } : null;
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
async function readClaims(method: string | null): Promise<ApiContext | NextResponse> {
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
    // Vế 4: request GHI phải chứng minh org của trang khớp org sắp ghi vào.
    const mismatch = checkRenderOrgMatch(ctx, method, renderOrgId);
    if (mismatch) return mismatch;
    return ctx;
  }

  // ═══════ CÓ TOKEN — LỚP B: check platform_admins ═══════
  //
  // Không kết luận được → 503, KHÔNG rơi xuống nhánh `!platform`. Nhánh đó
  // hiểu là "tenant cầm token bất thường" và lặng lẽ hạ xuống đường tenant;
  // với một platform admin thật gặp lỗi hạ tầng, đó là gán nhầm danh tính
  // rồi ghi log cảnh báo sai sự thật.
  let platform: Awaited<ReturnType<typeof checkPlatformAdmin>>;
  try {
    platform = await checkPlatformAdmin(jwt.userId);
  } catch {
    return NextResponse.json(
      { error: "platform_check_unavailable" },
      { status: 503 },
    );
  }

  if (!platform) {
    console.warn("[guard] non-platform user has org-context token", {
      userId: jwt.userId,
      email: jwt.email,
    });
    const ctx = resolveTenant(jwt);
    if (ctx instanceof NextResponse) return ctx;
    // Vế 4 áp cho nhánh này (tenant có token bất thường → bỏ token, đường tenant)
    const mismatch = checkRenderOrgMatch(ctx, method, renderOrgId);
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
  // độc-lập-cookie). Lệch hoặc thiếu → 409, đóng cửa sổ ghi-nhầm.
  const mismatch = checkRenderOrgMatch(ctx, method, renderOrgId);
  if (mismatch) return mismatch;

  return ctx;
}

// ============================================================================
// requirePermission — Non-strict: đọc role từ JWT claim, nhanh, chấp nhận
// token cũ vài phút.
//
// `req` là TÙY CHỌN nhưng nên truyền: guard lấy method từ đó để biết request
// này có phải request GHI hay không (vế 4). Không truyền → method = null →
// evaluateRenderOrg coi là đọc và bỏ qua kiểm tra ngữ cảnh org.
//
// Route GHI mà quên truyền `req` sẽ mất lớp chống ghi-nhầm-org. Script
// scripts/check-write-routes-pass-request.mjs chặn ca đó ở prebuild.
// ============================================================================
export async function requirePermission(
  permission: string,
  req?: Request
): Promise<ApiContext | NextResponse> {
  const ctx = await readClaims(req?.method ?? null);
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
// requirePermissionStrict — Strict: re-check role từ DB. Dùng cho
// create/update/delete nhạy.
//
// `req` tùy chọn — xem ghi chú ở requirePermission. Hàm này gần như luôn được
// gọi từ route GHI, nên gần như luôn phải truyền.
// ============================================================================
export async function requirePermissionStrict(
  permission: string,
  req?: Request
): Promise<ApiContext | NextResponse> {
  const ctx = await readClaims(req?.method ?? null);
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

  // 503 chứ không 403 khi không kết luận được: 403 nói "bạn không có quyền"
  // — sai sự thật với một platform admin thật, và đẩy người đi tìm lỗi
  // phân quyền trong khi hỏng là service key.
  let platform: Awaited<ReturnType<typeof checkPlatformAdmin>>;
  try {
    platform = await checkPlatformAdmin(jwt.userId);
  } catch {
    return NextResponse.json(
      { error: "platform_check_unavailable" },
      { status: 503 },
    );
  }
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

/**
 * Vai trò có quyền `permission` không — cùng nguồn `role_permission_matrix`
 * với requirePermission, dùng khi route cần hỏi thêm một quyền phụ (VD xem
 * camera trực tiếp) sau khi đã qua cửa chính.
 */
export async function roleHasPermission(
  role: Role,
  permission: string
): Promise<boolean> {
  return checkPermission(role, permission);
}

/**
 * Toàn bộ quyền của người đang đăng nhập — cho giao diện ẩn menu / nút mà
 * người đó không dùng được. Chỉ để HIỂN THỊ: mọi API vẫn tự kiểm quyền.
 * Platform admin đang xem một tổ chức = full quyền (khớp requirePermission).
 */
export async function getEffectivePermissions(): Promise<
  | { role: Role; isPlatform: boolean; permissions: string[] | "all" }
  | NextResponse
> {
  // Chỉ đọc ma trận quyền — không phải request ghi, method = null → vế 4 skip.
  const ctx = await readClaims(null);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.isPlatform) {
    return { role: ctx.role, isPlatform: true, permissions: "all" };
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("role_permission_matrix")
    .select("permission_code")
    .eq("role", ctx.role);
  if (error) {
    return NextResponse.json({ error: "permissions_unavailable" }, { status: 503 });
  }
  return {
    role: ctx.role,
    isPlatform: false,
    permissions: (data ?? []).map((r) => r.permission_code as string).sort(),
  };
}

// ============================================================================
// isError — KHÔNG ĐỔI
// ============================================================================
export function isError(x: ApiContext | NextResponse): x is NextResponse {
  return x instanceof NextResponse;
}
