import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { runCloseOrphanSegmentsJob } from "@/lib/system/orphan-segments";
import { verifyBearerSecret } from "@/lib/secure-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron đóng row `camera_recording_files` mồ côi (ended_at NULL quá cũ).
 *
 * Vì sao có: một row mồ côi từ 27/08 ở kho Đại Kim đã chặn cắt clip cho
 * 92 đơn liên tiếp trong 8 ngày. Resolver đã được vá để bỏ qua row loại
 * này, nhưng bản thân dữ liệu sai vẫn cần được dọn — xem đầu file
 * lib/system/orphan-segments.ts.
 *
 * Lịch: đặt ở systemd timer trên VPS, KHÔNG ở vercel.json (VPS không đọc
 * file đó — cron dọn clip từng chết âm thầm 5 ngày vì nhầm chỗ này).
 * Mỗi lần chạy ghi 1 dòng `system_jobs` để cảnh báo có mốc mà đọc.
 *
 * Local test:
 *   curl -k -H "Authorization: Bearer $CRON_SECRET" \
 *        https://localhost:3000/api/cron/close-orphan-segments
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!verifyBearerSecret(authHeader, cronSecret)) {
    // Chưa ghi system_jobs ở đây: request không chứng minh được là cron
    // thật, ai gõ sai secret cũng làm mốc "job còn sống" tươi lại được.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runCloseOrphanSegmentsJob();
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
