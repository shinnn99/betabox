import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { getPerformanceReport, type RangeInput, type RangeKey } from "@/lib/reports/service";

export const runtime = "nodejs";

const MAX_CUSTOM_DAYS = 366;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(value: string | null): RangeKey {
  if (value === "30d" || value === "90d") return value;
  return "7d";
}

function parseInput(req: NextRequest): RangeInput | { error: string } {
  const sp = req.nextUrl.searchParams;
  const fromParam = sp.get("from");
  const toParam = sp.get("to");

  if (fromParam || toParam) {
    if (!fromParam || !toParam) return { error: "from/to must both be provided" };
    if (!ISO_DATE_RE.test(fromParam) || !ISO_DATE_RE.test(toParam)) {
      return { error: "from/to must be YYYY-MM-DD" };
    }
    const fromMs = Date.parse(`${fromParam}T00:00:00Z`);
    const toMs = Date.parse(`${toParam}T00:00:00Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return { error: "invalid date" };
    }
    if (toMs < fromMs) return { error: "to must be >= from" };
    const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
    if (days > MAX_CUSTOM_DAYS) return { error: `range too large (max ${MAX_CUSTOM_DAYS} days)` };
    return { kind: "custom", range: { from: fromParam, to: toParam } };
  }

  return { kind: "preset", range: parseRange(sp.get("range")) };
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("report.view");
  if (isError(ctx)) return ctx;

  const parsed = parseInput(req);
  if ("error" in parsed) {
    return NextResponse.json({ error: "bad_request", message: parsed.error }, { status: 400 });
  }

  try {
    const report = await getPerformanceReport(ctx.organizationId, parsed);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: "report_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
