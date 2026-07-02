import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import {
  listScans,
  listScansByWaybill,
  type ListScansFilter,
} from "@/lib/order-proof/service";

export const runtime = "nodejs";

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
  const waybill = sp.get("waybill_code") ?? "";
  const exact = sp.get("exact") === "1";

  // Exact-match path retained for direct deep-links: <page>?waybill_code=X&exact=1
  // mirrors the original lookup behaviour. Anything else goes through the
  // forensic table list with optional filters.
  if (exact && waybill.trim()) {
    try {
      const scans = await listScansByWaybill(ctx.organizationId, waybill);
      return NextResponse.json({ scans, has_more: false });
    } catch (err) {
      return NextResponse.json(
        { error: "list_failed", message: (err as Error).message },
        { status: 500 },
      );
    }
  }

  const filter: ListScansFilter = {
    from: parseDate(sp.get("from")),
    to: parseDate(sp.get("to")),
    waybillCode: waybill || undefined,
    warehouseId: sp.get("warehouse_id") ?? undefined,
    stationId: sp.get("station_id") ?? undefined,
    scanStatus: ((): ListScansFilter["scanStatus"] => {
      const v = sp.get("scan_status");
      if (v === "valid" || v === "duplicated") return v;
      return "any";
    })(),
    clipStatus: ((): ListScansFilter["clipStatus"] => {
      const v = sp.get("clip_status");
      if (v === "none" || v === "ready" || v === "pending" || v === "failed") return v;
      return "any";
    })(),
    limit: parseLimit(sp.get("limit")),
    offset: parseLimit(sp.get("offset")) ?? 0,
  };

  try {
    const result = await listScans(ctx.organizationId, filter);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "list_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
