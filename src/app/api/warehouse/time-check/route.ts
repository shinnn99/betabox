import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * NTP guard runtime — agent gọi endpoint này để so clock.
 *
 * Trả server_time_utc = ISO NOW(). Agent so với `Date.now()` local,
 * tính drift. Gửi drift lên qua heartbeat (agent tự tính, backend chỉ
 * lưu, giảm coupling).
 *
 * KHÔNG auth: chỉ trả giờ, không lộ thông tin nhạy cảm. Bất kỳ ai
 * đọc được đều biết giờ Vercel — vô hại. Không cần HMAC agent để
 * giảm overhead check-drift 5 phút/lần.
 *
 * `Cache-Control: no-store` để CDN không cache time cũ.
 */
export function GET() {
  return NextResponse.json(
    {
      server_time_utc: new Date().toISOString(),
      server_time_ms: Date.now(),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
