import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { buildLiveSummary } from "@/lib/warehouse/live/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Màn hình giám sát KHÔNG còn gọi endpoint này (đã gộp vào
 * /api/warehouse/live/overview để cắt số request). Giữ lại làm cửa đọc
 * từng phần khi cần soi lỗi — logic nằm chung một chỗ nên không lệch.
 */
export async function GET() {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  return NextResponse.json(await buildLiveSummary(admin, ctx.organizationId));
}
