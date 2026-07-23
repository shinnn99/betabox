import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Ngưỡng agent online — khớp reaper pg_cron 5 phút.
const AGENT_ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

// GET /api/platform/orgs/[id] — trả tổng quan + thành viên + nhật ký cho 1 org.
//
// Chỉ SELECT qua admin client (platform admin bypass RLS đã có chỉnh ở
// requirePlatformRole). Endpoint mới, không đụng /dashboard/organization
// đang chạy cho org owner.
export async function GET(_req: Request, ctx: RouteContext) {
  const guard = await requirePlatformRole("platform_support");
  if (guard instanceof NextResponse) return guard;

  const { id: orgId } = await ctx.params;
  if (!orgId || typeof orgId !== "string") {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const admin = createAdminClient();
  const businessDate = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const errorSince = new Date(now - day).toISOString();
  const auditSince = new Date(now - 7 * day).toISOString();

  const [
    orgRes,
    profilesRes,
    warehousesRes,
    camerasRes,
    stationsRes,
    agentsRes,
    packingTodayRes,
    logsRes,
    auditRes,
    lastOrderRes,
    lastClipRes,
    lastImpersonateRes,
  ] = await Promise.all([
    admin
      .from("organizations")
      .select("id, name, slug, status, created_at, updated_at, logo_url, retention_days")
      .eq("id", orgId)
      .maybeSingle(),
    admin
      .from("user_profiles")
      .select("id, full_name, phone, role, status, created_at, updated_at")
      .eq("organization_id", orgId)
      .order("role")
      .order("created_at"),
    // Kèm notify_lark_webhook_url để tính có Webhook nào cấu hình chưa (dùng
    // ở sidebar Cấu hình). Chỉ đếm 'enabled=true AND url<>null'.
    admin
      .from("warehouses")
      .select("id, notify_lark_webhook_url, notify_lark_enabled")
      .eq("organization_id", orgId),
    admin
      .from("cameras")
      .select("id")
      .eq("organization_id", orgId),
    admin
      .from("packing_stations")
      .select("id, status")
      .eq("organization_id", orgId)
      .neq("status", "archived"),
    admin
      .from("warehouse_agents")
      .select("id, code, name, status, last_seen_at")
      .eq("organization_id", orgId)
      .order("code"),
    admin
      .from("packing_events")
      .select("status")
      .eq("organization_id", orgId)
      .eq("business_date", businessDate),
    admin
      .from("agent_log_events")
      .select("id, agent_id, level, message, emitted_at")
      .eq("organization_id", orgId)
      .in("level", ["warn", "error"])
      .gte("emitted_at", errorSince)
      .order("emitted_at", { ascending: false })
      .limit(50),
    // Nhật ký Platform Admin đụng org này. Không include impersonate stop
    // để tránh nhân đôi — start là đủ để biết "ai đã vào xem".
    admin
      .from("platform_audit_log")
      .select(
        "id, action, actor_email, actor_email_snapshot, metadata, created_at, target_organization_name_snapshot",
      )
      .or(`impersonating_org_id.eq.${orgId},target_id.eq.${orgId}`)
      .gte("created_at", auditSince)
      .order("created_at", { ascending: false })
      .limit(50),
    // "Đơn gần nhất" — packing_events mới nhất bất kể ngày. Bảng lớn nhưng
    // (organization_id, scanned_at DESC) là truy vấn nhanh.
    admin
      .from("packing_events")
      .select("waybill_code, scanned_at, status")
      .eq("organization_id", orgId)
      .order("scanned_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // "Clip gần nhất" — order_proof_clips.
    admin
      .from("order_proof_clips")
      .select("id, status, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // "Truy cập hỗ trợ gần nhất" — impersonate start gần nhất.
    admin
      .from("platform_audit_log")
      .select("actor_email, actor_email_snapshot, created_at")
      .eq("impersonating_org_id", orgId)
      .eq("action", "impersonate.start")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (orgRes.error) {
    return NextResponse.json({ error: orgRes.error.message }, { status: 500 });
  }
  if (!orgRes.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const org = orgRes.data;

  const members = (profilesRes.data ?? []) as Array<{
    id: string;
    full_name: string | null;
    phone: string | null;
    role: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>;

  // Owner đầu tiên (role='owner' + status='active') để hiển thị ở tổng quan.
  const owner = members.find((m) => m.role === "owner" && m.status === "active") ?? null;

  // Email + last_sign_in_at từ auth.users — 1 call/member. Chấp nhận N với
  // ~10 members/org.
  const memberIds = members.map((m) => m.id);
  const authByUserId = new Map<
    string,
    { email: string | null; last_sign_in_at: string | null }
  >();
  if (memberIds.length > 0) {
    const authResults = await Promise.all(
      memberIds.map((id) => admin.auth.admin.getUserById(id)),
    );
    for (let i = 0; i < memberIds.length; i += 1) {
      const u = authResults[i].data?.user;
      authByUserId.set(memberIds[i], {
        email: u?.email ?? null,
        last_sign_in_at: u?.last_sign_in_at ?? null,
      });
    }
  }

  const agents = (agentsRes.data ?? []) as Array<{
    id: string;
    code: string;
    name: string | null;
    status: string;
    last_seen_at: string | null;
  }>;
  const agentsActive = agents.filter((a) => a.status === "active");
  const agentsOnline = agentsActive.filter((a) => {
    if (!a.last_seen_at) return false;
    return now - new Date(a.last_seen_at).getTime() <= AGENT_ONLINE_THRESHOLD_MS;
  }).length;

  let ordersToday = 0;
  let ordersFailedToday = 0;
  for (const ev of packingTodayRes.data ?? []) {
    if (ev.status === "valid") ordersToday += 1;
    else if (
      ev.status === "duplicated" ||
      ev.status === "no_active_session" ||
      ev.status === "unmapped_scanner" ||
      ev.status === "invalid_code"
    ) {
      ordersFailedToday += 1;
    }
  }

  // "Hoạt động gần nhất" = mốc mới nhất trong 3 nguồn: agent heartbeat, đơn
  // gần nhất, impersonate gần nhất. Có gì lấy đó — nhiều nguồn thì lấy max.
  const activityCandidates = [
    ...agents.map((a) => a.last_seen_at).filter((v): v is string => !!v),
    lastOrderRes.data?.scanned_at as string | undefined,
    lastImpersonateRes.data?.created_at as string | undefined,
  ].filter((v): v is string => !!v);
  const lastActivityAt =
    activityCandidates.length > 0
      ? activityCandidates.sort().at(-1) ?? null
      : null;

  const webhooksConfigured =
    (warehousesRes.data ?? []).filter(
      (w) => !!w.notify_lark_webhook_url && w.notify_lark_enabled === true,
    ).length;

  const lastImpersonate = lastImpersonateRes.data
    ? {
        actor_email:
          (lastImpersonateRes.data.actor_email_snapshot as string | null) ??
          (lastImpersonateRes.data.actor_email as string | null),
        at: lastImpersonateRes.data.created_at as string,
      }
    : null;

  return NextResponse.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      logo_url: org.logo_url,
      retention_days: org.retention_days,
      created_at: org.created_at,
      updated_at: org.updated_at,
    },
    owner: owner
      ? {
          user_id: owner.id,
          full_name: owner.full_name,
          phone: owner.phone,
          email: authByUserId.get(owner.id)?.email ?? null,
          last_sign_in_at: authByUserId.get(owner.id)?.last_sign_in_at ?? null,
        }
      : null,
    totals: {
      users: members.length,
      warehouses: (warehousesRes.data ?? []).length,
      cameras: (camerasRes.data ?? []).length,
      stations: (stationsRes.data ?? []).length,
      agents_total: agentsActive.length,
      agents_online: agentsOnline,
      orders_today: ordersToday,
      orders_failed_today: ordersFailedToday,
    },
    last_activity_at: lastActivityAt,
    config: {
      webhooks_configured: webhooksConfigured,
    },
    recent: {
      last_order: lastOrderRes.data
        ? {
            waybill_code: lastOrderRes.data.waybill_code as string | null,
            status: lastOrderRes.data.status as string,
            at: lastOrderRes.data.scanned_at as string,
          }
        : null,
      last_clip: lastClipRes.data
        ? {
            id: lastClipRes.data.id as string,
            status: lastClipRes.data.status as string,
            at: lastClipRes.data.created_at as string,
          }
        : null,
      last_impersonate: lastImpersonate,
    },
    agents: agents.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      status: a.status,
      last_seen_at: a.last_seen_at,
      online:
        a.last_seen_at != null &&
        now - new Date(a.last_seen_at).getTime() <= AGENT_ONLINE_THRESHOLD_MS,
    })),
    members: members.map((m) => ({
      user_id: m.id,
      full_name: m.full_name,
      phone: m.phone,
      role: m.role,
      status: m.status,
      email: authByUserId.get(m.id)?.email ?? null,
      last_sign_in_at: authByUserId.get(m.id)?.last_sign_in_at ?? null,
      created_at: m.created_at,
    })),
    agent_logs: (logsRes.data ?? []).map((l) => ({
      id: l.id,
      agent_id: l.agent_id,
      level: l.level,
      message: l.message,
      emitted_at: l.emitted_at,
    })),
    platform_audit: (auditRes.data ?? []).map((a) => ({
      id: a.id,
      action: a.action,
      actor_email: a.actor_email_snapshot ?? a.actor_email,
      metadata: a.metadata,
      created_at: a.created_at,
    })),
  });
}
