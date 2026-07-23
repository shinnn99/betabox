import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { logPlatformAudit } from "@/lib/platform/audit";

// Slug generator — tách khỏi signup route để dùng chung. Loại dấu tiếng
// Việt + đưa về ASCII kebab.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function findAvailableSlug(
  admin: ReturnType<typeof createAdminClient>,
  baseSlug: string,
): Promise<string | null> {
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return null;
}

// Generate password random đủ mạnh: 16 ký tự alphanum + biểu tượng an toàn.
// Không bao gồm ký tự khó phân biệt (0/O, 1/l/I) để copy sang khách không
// nhầm. Dùng crypto.getRandomValues (Node 20+ có sẵn).
function generateRandomPassword(length = 16): string {
  const CHARSET =
    "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72; // bcrypt limit
const EMAIL_MAX_LENGTH = 254;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 100;

// GET /api/platform/orgs — list mọi org kèm counts + owner + health signals.
//
// Chỉ SELECT — không đụng route đang chạy. N+1 chấp nhận cho ~10-50 org.
// Ngưỡng agent online = 5 phút khớp reaper pg_cron (lat1_4_reaper).
const AGENT_ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, name, slug, status, created_at, retention_days")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const orgIds = (orgs ?? []).map((o) => o.id);
  if (orgIds.length === 0) {
    return NextResponse.json({ orgs: [] });
  }

  // business_date = UTC date, khớp với dashboard/overview + reports/service.
  const businessDate = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const errorSince = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const [
    profilesRes,
    warehousesRes,
    camerasRes,
    stationsRes,
    agentsRes,
    ownersRes,
    packingTodayRes,
    agentErrorsRes,
  ] = await Promise.all([
    admin
      .from("user_profiles")
      .select("organization_id")
      .in("organization_id", orgIds),
    admin
      .from("warehouses")
      .select("organization_id")
      .in("organization_id", orgIds),
    admin
      .from("cameras")
      .select("organization_id")
      .in("organization_id", orgIds),
    admin
      .from("packing_stations")
      .select("organization_id, status")
      .in("organization_id", orgIds)
      .neq("status", "archived"),
    admin
      .from("warehouse_agents")
      .select("organization_id, status, last_seen_at")
      .in("organization_id", orgIds),
    // Owner mỗi org: role='owner' + status='active'. Có thể null nếu owner
    // bị xóa hoặc bị chuyển vai trò — hiển thị "—".
    admin
      .from("user_profiles")
      .select("id, organization_id, full_name, role, status")
      .in("organization_id", orgIds)
      .eq("role", "owner")
      .eq("status", "active"),
    admin
      .from("packing_events")
      .select("organization_id, status")
      .in("organization_id", orgIds)
      .eq("business_date", businessDate),
    admin
      .from("agent_log_events")
      .select("organization_id, level")
      .in("organization_id", orgIds)
      .eq("level", "error")
      .gte("emitted_at", errorSince),
  ]);

  const bumpMap = <T,>(
    map: Map<string, number>,
    rows: T[] | null | undefined,
    getKey: (row: T) => string | null | undefined,
  ) => {
    for (const r of rows ?? []) {
      const k = getKey(r);
      if (!k) continue;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
  };

  const usersByOrg = new Map<string, number>();
  bumpMap(usersByOrg, profilesRes.data, (r) => r.organization_id);

  const warehousesByOrg = new Map<string, number>();
  bumpMap(warehousesByOrg, warehousesRes.data, (r) => r.organization_id);

  const camerasByOrg = new Map<string, number>();
  bumpMap(camerasByOrg, camerasRes.data, (r) => r.organization_id);

  const stationsByOrg = new Map<string, number>();
  bumpMap(stationsByOrg, stationsRes.data, (r) => r.organization_id);

  const agentsTotalByOrg = new Map<string, number>();
  const agentsOnlineByOrg = new Map<string, number>();
  for (const a of agentsRes.data ?? []) {
    const oId = a.organization_id as string;
    if (!oId) continue;
    if (a.status !== "active") continue;
    agentsTotalByOrg.set(oId, (agentsTotalByOrg.get(oId) ?? 0) + 1);
    const seen = a.last_seen_at ? new Date(a.last_seen_at as string).getTime() : 0;
    if (seen > 0 && now - seen <= AGENT_ONLINE_THRESHOLD_MS) {
      agentsOnlineByOrg.set(oId, (agentsOnlineByOrg.get(oId) ?? 0) + 1);
    }
  }

  const ownerByOrg = new Map<string, { userId: string; fullName: string | null }>();
  for (const p of ownersRes.data ?? []) {
    const oId = p.organization_id as string;
    if (!oId || ownerByOrg.has(oId)) continue; // giữ owner đầu tiên nếu >1 (edge case)
    ownerByOrg.set(oId, {
      userId: p.id as string,
      fullName: (p.full_name as string | null) ?? null,
    });
  }

  // Owner email từ auth.users — N call getUserById. Chỉ query owner tồn tại.
  const ownerIds = [...ownerByOrg.values()].map((o) => o.userId);
  const ownerEmailById = new Map<string, string | null>();
  if (ownerIds.length > 0) {
    const emailResults = await Promise.all(
      ownerIds.map((id) => admin.auth.admin.getUserById(id)),
    );
    for (let i = 0; i < ownerIds.length; i += 1) {
      const res = emailResults[i];
      ownerEmailById.set(ownerIds[i], res.data?.user?.email ?? null);
    }
  }

  // Đơn hôm nay = packing_events status='valid'. Cùng định nghĩa với
  // dashboard/overview.ts totals.valid.
  const ordersTodayByOrg = new Map<string, number>();
  for (const ev of packingTodayRes.data ?? []) {
    const oId = ev.organization_id as string;
    if (!oId || ev.status !== "valid") continue;
    ordersTodayByOrg.set(oId, (ordersTodayByOrg.get(oId) ?? 0) + 1);
  }

  const agentErrors24hByOrg = new Map<string, number>();
  bumpMap(agentErrors24hByOrg, agentErrorsRes.data, (r) => r.organization_id);

  const orgsEnriched = (orgs ?? []).map((o) => {
    const owner = ownerByOrg.get(o.id);
    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      created_at: o.created_at,
      retention_days: o.retention_days,
      owner: owner
        ? {
            full_name: owner.fullName,
            email: ownerEmailById.get(owner.userId) ?? null,
          }
        : null,
      stats: {
        users: usersByOrg.get(o.id) ?? 0,
        warehouses: warehousesByOrg.get(o.id) ?? 0,
        cameras: camerasByOrg.get(o.id) ?? 0,
        stations: stationsByOrg.get(o.id) ?? 0,
        agents_total: agentsTotalByOrg.get(o.id) ?? 0,
        agents_online: agentsOnlineByOrg.get(o.id) ?? 0,
        orders_today: ordersTodayByOrg.get(o.id) ?? 0,
        agent_errors_24h: agentErrors24hByOrg.get(o.id) ?? 0,
      },
    };
  });

  return NextResponse.json({ orgs: orgsEnriched });
}

// POST /api/platform/orgs — platform admin tạo org + owner user cho khách mới.
//
// Khác /api/signup (công khai, tắt vĩnh viễn Mốc 2):
//   * KHÔNG Turnstile, KHÔNG rate limit (platform admin trust).
//   * KHÔNG phụ thuộc SIGNUP_ENABLED env.
//   * Yêu cầu platform_support role trở lên.
//   * Audit vào platform_audit_log action=org.create.
//   * Trả về credentials để platform admin copy gửi khách.
//
// Body:
//   * owner_email, owner_full_name (bắt buộc)
//   * organization_name (bắt buộc)
//   * password (optional — nếu bỏ trắng, auto-generate + trả về)
//   * owner_phone, slug_override (optional)
//
// Transaction giống signup:
//   1. auth.users (email_confirm=true — không đòi verify email).
//   2. organizations.
//   3. user_profiles role=owner.
//   Fail giữa chừng → rollback tất cả (cleanup auth user + delete org đã tạo).
export async function POST(req: Request) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const b = body as {
    owner_email?: unknown;
    owner_full_name?: unknown;
    owner_phone?: unknown;
    organization_name?: unknown;
    password?: unknown;
    slug_override?: unknown;
  };

  const email = typeof b.owner_email === "string" ? b.owner_email.trim().toLowerCase() : "";
  const fullName = typeof b.owner_full_name === "string" ? b.owner_full_name.trim() : "";
  const orgName = typeof b.organization_name === "string" ? b.organization_name.trim() : "";
  const phone = typeof b.owner_phone === "string" ? b.owner_phone.trim() : null;
  const slugOverride = typeof b.slug_override === "string" ? b.slug_override.trim() : "";
  let password = typeof b.password === "string" ? b.password : "";
  const passwordAutoGenerated = password.length === 0;
  if (passwordAutoGenerated) {
    password = generateRandomPassword();
  }

  // Validate
  if (!email || email.length > EMAIL_MAX_LENGTH || !email.includes("@")) {
    return NextResponse.json(
      { error: "validation", message: "Email không hợp lệ." },
      { status: 400 },
    );
  }
  if (!fullName || fullName.length < NAME_MIN_LENGTH || fullName.length > NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: "validation", message: `Tên chủ tài khoản phải ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} ký tự.` },
      { status: 400 },
    );
  }
  if (!orgName || orgName.length < NAME_MIN_LENGTH || orgName.length > NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: "validation", message: `Tên tổ chức phải ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} ký tự.` },
      { status: 400 },
    );
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return NextResponse.json(
      { error: "validation", message: `Mật khẩu phải ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} ký tự.` },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Slug: dùng override nếu Hạnh nhập, không thì auto từ tên org.
  const baseSlug = slugOverride ? slugify(slugOverride) : slugify(orgName);
  if (!baseSlug) {
    return NextResponse.json(
      { error: "validation", message: "Không tạo được slug từ tên tổ chức. Nhập slug_override thủ công." },
      { status: 400 },
    );
  }
  const slug = await findAvailableSlug(admin, baseSlug);
  if (!slug) {
    return NextResponse.json(
      { error: "slug_exhausted", message: "Slug trùng quá nhiều, thử slug_override khác." },
      { status: 500 },
    );
  }

  // Transaction: auth.users → org → user_profiles.
  let createdUserId: string | null = null;
  let createdOrgId: string | null = null;

  try {
    // Bước 1: auth.users (email_confirm=true → khách login được ngay,
    // không cần verify email).
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      if (createErr?.message?.toLowerCase().includes("already")) {
        return NextResponse.json(
          { error: "email_taken", message: "Email này đã có tài khoản." },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "auth_create_failed", message: createErr?.message ?? "" },
        { status: 400 },
      );
    }
    createdUserId = created.user.id;

    // Bước 2: organizations.
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .insert({ name: orgName, slug })
      .select("id, name, slug")
      .single();
    if (orgErr || !org) {
      throw new Error(`org_insert: ${orgErr?.message}`);
    }
    createdOrgId = org.id;

    // Bước 3: user_profiles role=owner.
    const { error: profileErr } = await admin.from("user_profiles").insert({
      id: createdUserId,
      organization_id: org.id,
      role: "owner",
      full_name: fullName,
      phone,
      status: "active",
    });
    if (profileErr) {
      throw new Error(`profile_insert: ${profileErr.message}`);
    }

    // Audit — không log password vào metadata (rò credential nếu audit log lộ).
    await logPlatformAudit({
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      action: "org.create",
      targetType: "organization",
      targetId: org.id,
      targetOrganizationNameSnapshot: org.name,
      metadata: {
        owner_email: email,
        owner_full_name: fullName,
        slug: org.slug,
        password_auto_generated: passwordAutoGenerated,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        organization: {
          id: org.id,
          name: org.name,
          slug: org.slug,
        },
        owner: {
          user_id: createdUserId,
          email,
          full_name: fullName,
          // Chỉ trả password khi auto-generated. Nếu Hạnh nhập tay =
          // Hạnh đã biết, không cần echo lại.
          password: passwordAutoGenerated ? password : undefined,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    // Rollback theo thứ tự ngược: org đã tạo → xóa; auth.users → xóa.
    if (createdOrgId) {
      try {
        await admin.from("organizations").delete().eq("id", createdOrgId);
      } catch (delErr) {
        console.error(`[platform.orgs] rollback org ${createdOrgId} failed:`, delErr);
      }
    }
    if (createdUserId) {
      try {
        await admin.auth.admin.deleteUser(createdUserId);
      } catch (delErr) {
        console.error(
          `[platform.orgs] CRITICAL: rollback auth.users ${createdUserId} failed:`,
          delErr,
        );
      }
    }
    console.error("[platform.orgs] create failed:", err);
    return NextResponse.json(
      { error: "create_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
