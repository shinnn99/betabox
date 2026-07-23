import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";

// GET /api/platform/audit — xem log thao tác platform admin.
//
// Query params:
//   * limit (default 100, max 500) — số row entries mới nhất
//   * days (default 7) — cửa sổ tính stats. Response luôn kèm delta so với
//     window cùng độ dài liền trước.
export async function GET(req: Request) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  const rawDays = Number(url.searchParams.get("days") ?? 7);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 7;

  const admin = createAdminClient();

  const now = new Date();
  const currentSince = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const priorSince = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);

  const [rowsRes, currentStatsRes, priorStatsRes] = await Promise.all([
    admin
      .from("platform_audit_log")
      .select(
        "id, actor_user_id, actor_email, impersonating_org_id, action, target_type, target_id, metadata, ip_address, created_at, actor_email_snapshot, target_organization_name_snapshot",
      )
      .order("created_at", { ascending: false })
      .limit(limit),
    admin
      .from("platform_audit_log")
      .select("action, actor_user_id")
      .gte("created_at", currentSince.toISOString()),
    admin
      .from("platform_audit_log")
      .select("action, actor_user_id")
      .gte("created_at", priorSince.toISOString())
      .lt("created_at", currentSince.toISOString()),
  ]);

  if (rowsRes.error) {
    return NextResponse.json({ error: rowsRes.error.message }, { status: 500 });
  }
  const rows = rowsRes.data ?? [];

  // Enrich impersonating org name — snapshot trong row ưu tiên, fallback
  // query organizations table nếu snapshot null (record cũ trước migration
  // snapshot 20260707).
  const orgIds = Array.from(
    new Set(
      rows
        .map((r) => r.impersonating_org_id)
        .filter((id): id is string => id !== null)
    )
  );
  const orgNames = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    for (const o of orgs ?? []) orgNames.set(o.id, o.name);
  }

  const enriched = rows.map((r) => ({
    id: r.id,
    actor_user_id: r.actor_user_id,
    actor_email:
      (r.actor_email_snapshot as string | null) ??
      (r.actor_email as string | null),
    impersonating_org_id: r.impersonating_org_id,
    impersonating_org_name:
      (r.target_organization_name_snapshot as string | null) ??
      (r.impersonating_org_id
        ? orgNames.get(r.impersonating_org_id) ?? null
        : null),
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    metadata: r.metadata,
    ip_address: r.ip_address,
    created_at: r.created_at,
  }));

  // Stats: đếm event theo pattern trong 2 window để tính delta.
  const countStats = (
    rowsInWindow: Array<{ action: string; actor_user_id: string | null }>,
  ) => {
    // "impersonate.*" cũ và "platform.org.impersonate.*" mới cùng đếm 1.
    // Đếm start-only để không double-count (start+stop = 1 phiên).
    const impersonate = rowsInWindow.filter(
      (r) =>
        r.action === "impersonate.start" ||
        r.action === "platform.org.impersonate" ||
        r.action === "platform.org.impersonate.start",
    ).length;
    const failed = rowsInWindow.filter(
      (r) => r.action.endsWith(".fail") || r.action.endsWith(".failed"),
    ).length;
    // "Rủi ro cao" = action nhạy cảm hoặc thất bại (impersonate stop khi
    // hết time, org.lock, org.suspend, platform.admin.remove).
    const highRisk = rowsInWindow.filter(
      (r) =>
        r.action === "org.lock" ||
        r.action === "org.suspend" ||
        r.action === "platform.admin.remove" ||
        r.action.endsWith(".fail") ||
        r.action.endsWith(".failed"),
    ).length;
    const activeAdmins = new Set(
      rowsInWindow.map((r) => r.actor_user_id).filter((v) => !!v),
    ).size;
    return {
      total: rowsInWindow.length,
      impersonate,
      failed,
      high_risk: highRisk,
      active_admins: activeAdmins,
    };
  };

  const currentStats = countStats(currentStatsRes.data ?? []);
  const priorStats = countStats(priorStatsRes.data ?? []);
  const delta = (cur: number, prev: number): number | null => {
    if (prev === 0) return cur > 0 ? null : 0; // "so với 0" không có ý nghĩa % → null
    return Math.round(((cur - prev) / prev) * 100);
  };
  const stats = {
    window_days: days,
    current: currentStats,
    prior: priorStats,
    delta: {
      total: delta(currentStats.total, priorStats.total),
      impersonate: delta(currentStats.impersonate, priorStats.impersonate),
      failed: delta(currentStats.failed, priorStats.failed),
      high_risk: delta(currentStats.high_risk, priorStats.high_risk),
      active_admins: delta(
        currentStats.active_admins,
        priorStats.active_admins,
      ),
    },
  };

  return NextResponse.json({ entries: enriched, stats });
}
