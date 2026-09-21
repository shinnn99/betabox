import { NextResponse } from "next/server";
import { getEffectivePermissions } from "@/lib/supabase/guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/session-permissions — quyền của người đang đăng nhập, để giao
 * diện ẩn menu / nút không dùng được. Chỉ phục vụ hiển thị; API nào cũng
 * tự kiểm quyền lại.
 */
export async function GET() {
  const result = await getEffectivePermissions();
  if (result instanceof NextResponse) return result;
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
