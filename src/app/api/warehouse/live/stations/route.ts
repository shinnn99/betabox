import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { buildLiveStations } from "@/lib/warehouse/live/stations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Xem chú thích ở /api/warehouse/live/summary — đã gộp vào overview. */
export async function GET() {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  return NextResponse.json(await buildLiveStations(admin, ctx.organizationId));
}
