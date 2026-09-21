import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { buildLiveSummary } from "@/lib/warehouse/live/summary";
import { buildLiveStations } from "@/lib/warehouse/live/stations";
import { parseIssuesLimit } from "@/lib/warehouse/live/issues";
import { parseActivityLimit } from "@/lib/warehouse/live/activity";
import { resolveActivitySection } from "@/lib/warehouse/live/overview";
import { buildReturnActivity, buildReturnIssues } from "@/lib/warehouse/live/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Một cửa cho màn hình Giám sát hoàn hàng — anh em của
 * /api/warehouse/live/overview (Giám sát đóng hàng), tách route riêng theo
 * chốt của chủ dự án: hai phần mới đứng riêng, không đổi chức năng bên
 * trong phần cũ.
 *
 * Cùng hình dạng phản hồi, cùng hai tầng lỗi như bản đóng hàng:
 *  - summary/stations/issues hỏng → 500 cả request;
 *  - activity hỏng → vẫn 200, đẩy xuống `activity_error`.
 */
export async function GET(req: NextRequest) {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const orgId = ctx.organizationId;
  const params = req.nextUrl.searchParams;
  const includeActivity = params.get("include_activity") !== "0";
  const dateParam = params.get("date");
  const issuesLimit = parseIssuesLimit(params.get("issues_limit"));
  const activityLimit = parseActivityLimit(params.get("activity_limit"));

  const [summary, stations, issues, activitySection] = await Promise.all([
    buildLiveSummary(admin, orgId, "return"),
    buildLiveStations(admin, orgId, "return"),
    buildReturnIssues(admin, orgId, issuesLimit),
    resolveActivitySection(includeActivity, () =>
      buildReturnActivity(admin, orgId, dateParam, activityLimit),
    ),
  ]);

  return NextResponse.json({
    summary,
    stations,
    issues,
    activity: activitySection.activity,
    activity_error: activitySection.activity_error,
  });
}
