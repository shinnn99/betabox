import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";

// GET /api/platform/audit — xem log thao tác platform admin
export async function GET(req: Request) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("platform_audit_log")
    .select(
      "id, actor_user_id, actor_email, impersonating_org_id, action, target_type, target_id, metadata, ip_address, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich impersonating org name
  const orgIds = Array.from(
    new Set(
      (rows ?? [])
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

  const enriched = (rows ?? []).map((r) => ({
    ...r,
    impersonating_org_name: r.impersonating_org_id
      ? orgNames.get(r.impersonating_org_id) ?? null
      : null,
  }));

  return NextResponse.json({ entries: enriched });
}
