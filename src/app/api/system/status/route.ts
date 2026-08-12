import { NextResponse } from "next/server";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHECK_CONFIG, runSystemChecks, worstStatus } from "@/lib/system/checks";
import { SYSTEM_JOB_SYSTEM_CHECK } from "@/lib/system/alert";
import { errorMessage } from "@/lib/system/job-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/system/status — cùng 6 mục kiểm với /api/system/check, nhưng
 * KHÔNG gửi cảnh báo và KHÔNG ghi sổ. Chỉ đọc, cho trang /platform/system.
 *
 * HAI LỚP BẢO VỆ, cố ý:
 *   1. Proxy (middleware): route này KHÔNG nằm trong PUBLIC_API_PREFIXES,
 *      nên request không có session hợp lệ bị chặn từ vòng ngoài với
 *      {"error":"unauthenticated"} — không bao giờ chạm tới đây.
 *   2. requirePlatformRole: khách thuê (kể cả owner của org) dừng ở đây với
 *      {"error":"forbidden_platform_only"}. Đây là dữ liệu hạ tầng nội bộ
 *      Betacom — dung lượng ổ VPS, tên agent của MỌI kho, mã camera của
 *      MỌI khách. Không org nào được nhìn.
 *
 * KHÔNG dùng requirePermission*: platform admin không có organization_id
 * trong JWT nên hàm đó sẽ 403 họ. Đây cũng là lý do trang nằm ở /platform
 * chứ không /dashboard — xem ghi chú ở src/app/platform/system/page.tsx.
 */
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const now = new Date();
  const checks = await runSystemChecks({ now });

  // Mốc "con cảnh báo nền còn sống không" — thứ mà bản thân trang này
  // không tự trả lời được: trang xanh nhưng timer chết thì vẫn mù.
  let lastBackgroundRun: string | null = null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("system_jobs")
      .select("ran_at")
      .eq("job_name", SYSTEM_JOB_SYSTEM_CHECK)
      .order("ran_at", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(CHECK_CONFIG.queryTimeoutMs));
    lastBackgroundRun = (data as Array<{ ran_at: string }> | null)?.[0]?.ran_at ?? null;
  } catch (err) {
    // Không đọc được mốc không phải lý do làm hỏng cả trang.
    console.warn("[system-status] không đọc được lần chạy nền:", errorMessage(err));
  }

  return NextResponse.json({
    ok: true,
    checked_at: now.toISOString(),
    worst: worstStatus(checks),
    checks,
    last_background_run: lastBackgroundRun,
  });
}
