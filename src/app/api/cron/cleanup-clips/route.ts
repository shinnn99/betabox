import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cleanupExpiredClips } from "@/lib/watch/cleanup";

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
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await cleanupExpiredClips();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
