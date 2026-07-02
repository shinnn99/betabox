import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { getPerformanceReport, type RangeKey } from "@/lib/reports/service";

export const runtime = "nodejs";

function parseRange(value: string | null): RangeKey {
  if (value === "30d" || value === "90d") return value;
  return "7d";
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("report.view");
  if (isError(ctx)) return ctx;

  const range = parseRange(req.nextUrl.searchParams.get("range"));

  try {
    const report = await getPerformanceReport(ctx.organizationId, range);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: "report_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
