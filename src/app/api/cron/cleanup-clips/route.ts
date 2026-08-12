import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { runCleanupClipsJob } from "@/lib/system/cleanup-clips-job";
import { verifyBearerSecret } from "@/lib/secure-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 1.1: Vercel Cron endpoint cho cleanup clip bucket quá hạn.
 *
 * Chuẩn Vercel docs 2026-06-02: GET + `Authorization: Bearer $CRON_SECRET`.
 * Vercel tự inject header khi gọi theo lịch trong vercel.json.
 *
 * Local test:
 *   curl -k -H "Authorization: Bearer $CRON_SECRET" \
 *        https://localhost:3000/api/cron/cleanup-clips
 *
 * Endpoint admin cũ (/api/admin/cleanup-expired-clips) vẫn giữ nguyên
 * cho admin bấm tay qua UI/session. Cả hai gọi cùng helper cleanupExpiredClips().
 *
 * 12/08/2026 — VPS: lịch không còn ở vercel.json (VPS không đọc file đó,
 * cron chết âm thầm 5 ngày vì thế) mà ở systemd timer trên máy chủ. Mỗi
 * lần chạy giờ ghi 1 dòng `system_jobs` qua runCleanupClipsJob() để cảnh
 * báo có mốc "lần chạy gần nhất" mà đọc — ghi sổ nằm trong helper, không
 * làm hỏng việc dọn nếu ghi lỗi.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!verifyBearerSecret(authHeader, cronSecret)) {
    // Ở đây CHƯA ghi system_jobs: request không chứng minh được là cron
    // thật, ai gõ sai secret cũng làm mốc "cron còn sống" tươi lại được.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runCleanupClipsJob();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
