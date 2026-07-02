import { NextResponse } from "next/server";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Returns warehouses + stations available to the current org so the
// filter dropdowns can populate. Cheap; called once on page mount.
export async function GET() {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const [warehouses, stations] = await Promise.all([
    admin
      .from("warehouses")
      .select("id, code, name, status")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "active")
      .order("code"),
    admin
      .from("packing_stations")
      .select("id, code, name, warehouse_id, status")
      .eq("organization_id", ctx.organizationId)
      .eq("status", "active")
      .order("code"),
  ]);

  return NextResponse.json({
    warehouses: warehouses.data ?? [],
    stations: stations.data ?? [],
  });
}
