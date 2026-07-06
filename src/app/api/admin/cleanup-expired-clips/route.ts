import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cleanupExpiredClips } from "@/lib/watch/cleanup";
import { secureCompare } from "@/lib/secure-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 3c/1.1: cleanup clip quá hạn khỏi bucket + reset cột DB (admin route).
 *
 * HAI ĐƯỜNG VÀO:
 *   (a) Session user role='admin' — bấm tay lúc test/vận hành.
 *   (b) Header `x-cron-secret: <CRON_SECRET>` — cron ngoài Vercel (hoặc
 *       backward-compat với client cũ dùng x-cron-secret pattern).
 *
 * Vercel Cron mặc định dùng chuẩn `Authorization: Bearer` (docs 2026-06-02)
 * và endpoint riêng /api/cron/cleanup-clips (GET). Endpoint này chỉ giữ
 * cho admin session + backward-compat.
 */
export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers.get("x-cron-secret");
  let authorized = false;
  let authMode: "cron_secret" | "admin_session" | null = null;

  if (secureCompare(providedSecret, cronSecret)) {
    authorized = true;
    authMode = "cron_secret";
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from("user_profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profile && profile.role === "admin") {
        authorized = true;
        authMode = "admin_session";
      }
    }
  }

  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await cleanupExpiredClips();
  if (!result.ok) {
    return NextResponse.json({ ...result, auth_mode: authMode }, { status: 500 });
  }
  return NextResponse.json({ ...result, auth_mode: authMode });
}
