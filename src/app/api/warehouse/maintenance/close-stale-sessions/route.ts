import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  requirePermissionStrict,
  isError,
} from "@/lib/supabase/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manually trigger close_stale_sessions for the caller's organization.
 *
 * Auth modes (one OR the other):
 *  (A) User session with `warehouse.update` permission — UI "Đóng phiên
 *      treo ngay" button calls this.
 *  (B) Header `x-maintenance-secret` matching env MAINTENANCE_SECRET —
 *      for external cron / scheduled jobs that don't have a user session.
 *      When using mode B, pass ?organization_id=... in the query to scope.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const maintenanceSecret = req.headers.get("x-maintenance-secret");
  const expectedSecret = process.env.MAINTENANCE_SECRET;

  let organizationId: string | null = null;
  let actorUserId: string | null = null;
  let actorEmail: string | null = null;

  if (maintenanceSecret && expectedSecret && maintenanceSecret === expectedSecret) {
    // Mode B: external scheduler. Org must be passed explicitly or null
    // (meaning all orgs — only allowed via shared secret).
    const orgParam = url.searchParams.get("organization_id");
    organizationId = orgParam || null;
  } else {
    // Mode A: user session.
    const ctx = await requirePermissionStrict("warehouse.update");
    if (isError(ctx)) return ctx;
    organizationId = ctx.organizationId;
    actorUserId = ctx.userId;
    actorEmail = ctx.email;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("close_stale_sessions", { p_organization_id: organizationId })
    .single<{ closed_sessions: number; closed_packing_events: number }>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Audit nếu được kích hoạt bởi user. Cron silent — nếu cần audit cron
  // riêng có thể thêm sau với actor_type='system'.
  if (actorUserId && organizationId && data) {
    if (data.closed_sessions > 0 || data.closed_packing_events > 0) {
      await audit({
        organizationId,
        actorUserId,
        actorEmail: actorEmail ?? undefined,
        action: "warehouse.close_stale_sessions",
        metadata: {
          closed_sessions: data.closed_sessions,
          closed_packing_events: data.closed_packing_events,
        },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    closed_sessions: data?.closed_sessions ?? 0,
    closed_packing_events: data?.closed_packing_events ?? 0,
  });
}
