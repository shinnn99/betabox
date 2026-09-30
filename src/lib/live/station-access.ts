import "server-only";

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isError,
  requirePermission,
  roleHasPermission,
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

/** Cho phép người xem mọi bàn (live.view_remote) hoặc tài khoản được gán đúng bàn này (live.view_station). */
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

  // Phạm vi xem đi theo bảng quyền Platform chỉnh được, không theo tên vai
  // trò: live.view_remote = mọi bàn; live.view_station = chỉ bàn được gán.
  const canViewRemote =
    !ctx.isPlatform && (await roleHasPermission(ctx.role, "live.view_remote"));
  const canViewStation =
    !ctx.isPlatform &&
    !canViewRemote &&
    (await roleHasPermission(ctx.role, "live.view_station"));

  let assignedStationId: string | null = null;
  if (canViewStation) {
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
    canViewRemote,
    canViewStation,
  });
  if (scope === "forbidden") {
    return NextResponse.json({ error: "station_live_forbidden" }, { status: 403 });
  }

  return { admin, ctx, scope, station };
}
