import "server-only";

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isError,
  requirePermission,
  type ApiContext,
} from "@/lib/supabase/guard";
import {
  resolveStationLiveScope,
  type StationLiveScope,
} from "@/lib/live/station-streams";

export interface StationLiveAccess {
  admin: ReturnType<typeof createAdminClient>;
  ctx: ApiContext;
  scope: Exclude<StationLiveScope, "forbidden">;
  station: { id: string; code: string; name: string; status: string };
}

/** Authorize an admin viewer or the packer account assigned to this station. */
export async function requireStationLiveAccess(
  stationId: string,
): Promise<StationLiveAccess | NextResponse> {
  if (!/^[0-9a-f-]{36}$/i.test(stationId)) {
    return NextResponse.json({ error: "station_id_invalid" }, { status: 400 });
  }

  let ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) {
    if (ctx.status !== 403) return ctx;
    ctx = await requirePermission("live.view_station");
    if (isError(ctx)) return ctx;
  }

  const admin = createAdminClient();
  const { data: station, error: stationError } = await admin
    .from("packing_stations")
    .select("id, code, name, status")
    .eq("id", stationId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (stationError) {
    return NextResponse.json(
      { error: "station_lookup_failed", message: stationError.message },
      { status: 500 },
    );
  }
  if (!station || station.status !== "active") {
    return NextResponse.json({ error: "station_not_found" }, { status: 404 });
  }

  let assignedStationId: string | null = null;
  if (!ctx.isPlatform && ctx.role === "packer") {
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .select("station_id")
      .eq("id", ctx.userId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (profileError) {
      return NextResponse.json(
        {
          error: "station_assignment_unavailable",
          message: "Chưa áp dụng schema gán tài khoản vào bàn đóng hàng.",
        },
        { status: 409 },
      );
    }
    assignedStationId = profile?.station_id ?? null;
  }

  const scope = resolveStationLiveScope({
    role: ctx.role,
    isPlatform: ctx.isPlatform,
    requestedStationId: stationId,
    assignedStationId,
  });
  if (scope === "forbidden") {
    return NextResponse.json({ error: "station_live_forbidden" }, { status: 403 });
  }

  return { admin, ctx, scope, station };
}
