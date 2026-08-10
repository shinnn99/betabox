import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { buildLiveSummary } from "@/lib/warehouse/live/summary";
import { buildLiveStations } from "@/lib/warehouse/live/stations";
import { buildLiveIssues, parseIssuesLimit } from "@/lib/warehouse/live/issues";
import {
  buildLiveActivity,
  parseActivityLimit,
} from "@/lib/warehouse/live/activity";
import { resolveActivitySection } from "@/lib/warehouse/live/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Một cửa cho toàn bộ màn hình giám sát: summary + stations + issues +
 * activity trong MỘT request.
 *
 * Lý do tồn tại là hoá đơn Vercel: trang giám sát poll 3 giây/lần và trước
 * đây mỗi nhịp bắn 4 request riêng → 4.800 request/giờ cho một tab mở.
 * Gộp lại còn 1.200 mà nhịp làm mới vẫn y nguyên 3 giây, người ở kho không
 * thấy khác gì.
 *
 * Hai tầng lỗi được GIỮ NGUYÊN như khi còn 4 endpoint rời:
 *  - summary/stations/issues hỏng → 500 cả request (trang dựng banner đỏ,
 *    vì thiếu ba khối này thì màn hình giám sát vô nghĩa).
 *  - activity hỏng → vẫn 200, đẩy xuống `activity_error` (chỉ bảng nhật ký
 *    báo lỗi cục bộ, KPI và thẻ bàn vẫn vẽ bình thường).
 * Gộp endpoint mà gộp luôn hai tầng lỗi này là âm thầm đổi hành vi:
 * một lỗi nhật ký sẽ thổi bay cả màn hình.
 *
 * `include_activity=0`: nhịp poll của một ngày quá khứ. Đơn ngày cũ đã
 * đóng, nhật ký không đổi nữa — tính lại mỗi 3 giây là đốt CPU vô ích.
 * Client vẫn gọi một lượt có activity khi đổi ngày / bấm "Tải thêm".
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
    buildLiveSummary(admin, orgId),
    buildLiveStations(admin, orgId),
    buildLiveIssues(admin, orgId, issuesLimit),
    resolveActivitySection(includeActivity, () =>
      buildLiveActivity(admin, orgId, dateParam, activityLimit),
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
