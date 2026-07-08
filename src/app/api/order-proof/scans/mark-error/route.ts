import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermissionStrict } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface Body {
  ids?: unknown;
  flagged?: unknown;
}

const MAX_IDS = 200;

export async function POST(req: NextRequest) {
  const ctx = await requirePermissionStrict("order_proof.generate");
  if (isError(ctx)) return ctx;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const rawIds = Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds || rawIds.length === 0) {
    return NextResponse.json({ error: "ids_required" }, { status: 400 });
  }
  if (rawIds.length > MAX_IDS) {
    return NextResponse.json(
      { error: "too_many_ids", max: MAX_IDS },
      { status: 400 },
    );
  }
  const ids = rawIds.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids_required" }, { status: 400 });
  }

  const flagged = body.flagged === true;

  const admin = createAdminClient();
  const patch = flagged
    ? {
        manual_error: true,
        manual_error_at: new Date().toISOString(),
        manual_error_by: ctx.userId,
      }
    : {
        manual_error: false,
        manual_error_at: null,
        manual_error_by: null,
      };

  const { data, error } = await admin
    .from("packing_events")
    .update(patch)
    .eq("organization_id", ctx.organizationId)
    .in("id", ids)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: "update_failed", message: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    updated: (data ?? []).length,
    flagged,
  });
}
