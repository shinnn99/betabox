import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { buildLiveIssues, parseIssuesLimit } from "@/lib/warehouse/live/issues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Xem chú thích ở /api/warehouse/live/summary — đã gộp vào overview. */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const limit = parseIssuesLimit(req.nextUrl.searchParams.get("limit"));
  return NextResponse.json(
    await buildLiveIssues(admin, ctx.organizationId, limit),
  );
}
