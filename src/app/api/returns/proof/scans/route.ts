import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { listScans } from "@/lib/order-proof/service";

export const runtime = "nodejs";

/**
 * Danh sách kiện hoàn cho trang Bằng chứng hoàn hàng — anh em của
 * /api/order-proof/scans (Bằng chứng giao hàng). Route riêng, luôn chỉ trả
 * kiện hoàn; không có tham số nào đổi được sang đơn đi.
 */

function parseDate(s: string | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseLimit(s: string | null): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function GET(req: NextRequest) {
  const ctx = await requirePermission("order_proof.view");
  if (isError(ctx)) return ctx;

  const sp = req.nextUrl.searchParams;
  try {
    const result = await listScans(ctx.organizationId, {
      from: parseDate(sp.get("from")),
      to: parseDate(sp.get("to")),
      waybillCode: sp.get("waybill_code") || undefined,
      stationId: sp.get("station_id") ?? undefined,
      limit: parseLimit(sp.get("limit")),
      offset: parseLimit(sp.get("offset")) ?? 0,
      eventKind: "return",
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "list_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
