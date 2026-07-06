import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";

// GET /api/platform/orgs — list mọi org (platform admin bypass RLS qua admin client)
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, name, slug, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Đếm user + warehouse cho mỗi org (thống kê nhẹ)
  const orgIds = (orgs ?? []).map((o) => o.id);
  const stats = new Map<string, { users: number; warehouses: number }>();
  if (orgIds.length > 0) {
    const [usersResult, whResult] = await Promise.all([
      admin
        .from("user_profiles")
        .select("organization_id", { count: "exact" })
        .in("organization_id", orgIds),
      admin
        .from("warehouses")
        .select("organization_id", { count: "exact" })
        .in("organization_id", orgIds),
    ]);

    for (const orgId of orgIds) {
      const users = (usersResult.data ?? []).filter(
        (r) => r.organization_id === orgId
      ).length;
      const warehouses = (whResult.data ?? []).filter(
        (r) => r.organization_id === orgId
      ).length;
      stats.set(orgId, { users, warehouses });
    }
  }

  const orgsWithStats = (orgs ?? []).map((o) => ({
    ...o,
    stats: stats.get(o.id) ?? { users: 0, warehouses: 0 },
  }));

  return NextResponse.json({ orgs: orgsWithStats });
}
