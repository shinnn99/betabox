import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import {
  buildLiveActivity,
  parseActivityLimit,
} from "@/lib/warehouse/live/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Xem chú thích ở /api/warehouse/live/summary — đã gộp vào overview. */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const limit = parseActivityLimit(req.nextUrl.searchParams.get("limit"));
  try {
    return NextResponse.json(
      await buildLiveActivity(
        admin,
        ctx.organizationId,
        req.nextUrl.searchParams.get("date"),
        limit,
      ),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
