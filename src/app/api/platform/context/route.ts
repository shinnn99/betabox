import { NextResponse } from "next/server";
import { requirePlatformRole } from "@/lib/supabase/guard";

// GET /api/platform/context — trả thông tin platform admin đang login
// Dùng cho hook client (usePlatformSession) tương đương useSession cho tenant.
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  return NextResponse.json({
    userId: ctx.userId,
    email: ctx.email,
    platformRole: ctx.platformRole,
  });
}
