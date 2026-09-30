import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { getOperationsReport } from "@/lib/reports/operations";
import { shiftDateKey, vnDateKey } from "@/lib/time/vietnam";

export const runtime = "nodejs";

const MAX_CUSTOM_DAYS = 366;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

type Parsed = { from: string; to: string } | { error: string };

/**
 * Khoảng ngày tính theo LỊCH VIỆT NAM (vnDateKey), không phải
 * `toISOString().slice(0,10)`. Route chạy TZ=UTC: từ 00:00 đến 06:59 giờ VN
 * thì ngày UTC vẫn là hôm qua, nên "7 ngày gần nhất" mở lúc sáng sớm sẽ mất
 * hẳn ngày hôm nay.
 */
function parseInput(req: NextRequest): Parsed {
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
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { error: "invalid date" };
    if (toMs < fromMs) return { error: "to must be >= from" };
    const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
    if (days > MAX_CUSTOM_DAYS) {
      return { error: `range too large (max ${MAX_CUSTOM_DAYS} days)` };
    }
    return { from: fromParam, to: toParam };
  }

  const days = PRESET_DAYS[sp.get("range") ?? "7d"] ?? 7;
  const to = vnDateKey();
  return { from: shiftDateKey(to, -(days - 1)), to };
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("report.view");
  if (isError(ctx)) return ctx;

  const parsed = parseInput(req);
  if ("error" in parsed) {
    return NextResponse.json({ error: "bad_request", message: parsed.error }, { status: 400 });
  }

  try {
    const report = await getOperationsReport(ctx.organizationId, parsed.from, parsed.to);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: "report_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
