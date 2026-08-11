import { NextResponse } from "next/server";

/**
 * Liveness probe cho uptime monitor + verify Nginx route đúng sau cutover VPS.
 *
 * Trả lời ĐÚNG MỘT câu: process Next còn sống và reverse proxy còn trỏ đúng
 * không. CỐ Ý không chạm Supabase:
 *   - Supabase chớp nhoáng → monitor báo app chết trong khi app vẫn phục vụ
 *     được mọi trang không cần DB.
 *   - Endpoint public mà kiểm hạ tầng phía sau = đòn bẩy dò cho người ngoài.
 * Muốn kiểm sâu (DB/bucket) thì làm route riêng SAU bearer secret, đừng nhét
 * vào đây.
 *
 * Route nằm trong PUBLIC_API_PREFIXES (src/lib/supabase/proxy.ts) — monitor
 * không có cookie, qua middleware session sẽ ăn redirect/401 rồi báo down 24/7.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
