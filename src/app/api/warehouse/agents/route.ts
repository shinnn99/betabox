import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";

export const runtime = "nodejs";

/**
 * List warehouse_agents for the current org plus their last-discovery
 * snapshot. The UI uses this for the device-pairing screen so a manager
 * can see "Agent X is currently seeing 3 ports".
 */
export async function GET() {
  const ctx = await requirePermission("station_device.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("warehouse_agents")
    .select(
      "id, code, name, status, last_seen_at, last_discovered_at, last_discovered_scanners",
    )
    .eq("organization_id", ctx.organizationId)
    .order("code");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ agents: data ?? [] });
}
