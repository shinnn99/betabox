import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";
import { resolveVietnamDayScope } from "@/lib/warehouse/time-range";
import { buildProofSizeRisks, parseProofRiskLimit } from "@/lib/order-proof/proof-size-risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cảnh báo sớm clip kiện hoàn vượt trần tải lên — anh em của
 * /api/warehouse/live/proof-size-risk. Clip kiện hoàn dài tới 5 phút nên
 * càng dễ vượt trần hơn đơn đi; vượt thì hồ sơ khiếu nại không có video.
 */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const day = resolveVietnamDayScope(req.nextUrl.searchParams.get("date"));
  try {
    const result = await buildProofSizeRisks({
      admin: createAdminClient(),
      orgId: ctx.organizationId,
      day,
      limit: parseProofRiskLimit(req.nextUrl.searchParams.get("limit")),
      eventKind: "return",
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
