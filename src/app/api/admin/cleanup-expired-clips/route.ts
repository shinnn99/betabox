import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { BUCKET_NAME, BUCKET_TTL_HOURS } from "@/lib/watch/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 3c: cleanup clip quá hạn khỏi bucket + reset cột DB.
 *
 * HAI ĐƯỜNG VÀO — CHỦ Ý xây từ đầu để không phải viết lại lúc nối
 * Vercel Cron:
 *   (a) Session user với role='admin' — dùng để bấm tay lúc test/vận hành.
 *   (b) Header `x-cron-secret: <CRON_SECRET>` — Vercel Cron / cron ngoài
 *       gọi (không có session). Set CRON_SECRET trong env, cấu hình
 *       Vercel Cron với header đó.
 *
 * BLOCKS-GO-LIVE (MỨC CAO — xem migration): endpoint này CHƯA có
 * scheduler tự động. Chạy tay thì OK cho test, nhưng NẾU GO-LIVE
 * KHÔNG NỐI Vercel Cron thì cleanup không chạy = TTL vô nghĩa =
 * cloud giữ clip vĩnh viễn = phản triết lý ổ-khách. KHÔNG PHẢI TASK
 * KỸ THUẬT VẶT.
 */
export async function POST(req: Request) {
  // Đường (b): CRON_SECRET header
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers.get("x-cron-secret");
  let authorized = false;
  let authMode: "cron_secret" | "admin_session" | null = null;

  if (cronSecret && providedSecret && providedSecret === cronSecret) {
    authorized = true;
    authMode = "cron_secret";
  } else {
    // Đường (a): admin session
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

  const admin = createAdminClient();

  // Tìm clip quá hạn
  const cutoffIso = new Date(
    Date.now() - BUCKET_TTL_HOURS * 3600 * 1000,
  ).toISOString();

  const { data: expired, error: fetchErr } = await admin
    .from("order_proof_clips")
    .select("id, packing_event_id, bucket_path, bucket_uploaded_at")
    .not("bucket_uploaded_at", "is", null)
    .lt("bucket_uploaded_at", cutoffIso);

  if (fetchErr) {
    return NextResponse.json(
      { error: "fetch_failed", message: fetchErr.message },
      { status: 500 },
    );
  }

  const rows = expired ?? [];
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      auth_mode: authMode,
      deleted: 0,
      cutoff_iso: cutoffIso,
    });
  }

  // Xóa file bucket (batch remove supported)
  const paths = rows.map((r) => r.bucket_path).filter((p): p is string => !!p);
  let removeErrors: string[] = [];
  if (paths.length > 0) {
    const { error: remErr } = await admin.storage
      .from(BUCKET_NAME)
      .remove(paths);
    if (remErr) {
      removeErrors.push(remErr.message);
    }
  }

  // Reset cột DB (dù bucket remove có lỗi hay không, reset cột để
  // lần watch sau reconcile thấy null và re-upload — hoặc user retry).
  const ids = rows.map((r) => r.id);
  const { error: updErr } = await admin
    .from("order_proof_clips")
    .update({
      bucket_path: null,
      bucket_uploaded_at: null,
    })
    .in("id", ids);

  if (updErr) {
    return NextResponse.json(
      {
        error: "db_update_failed",
        message: updErr.message,
        remove_errors: removeErrors,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    auth_mode: authMode,
    deleted: rows.length,
    cutoff_iso: cutoffIso,
    remove_errors: removeErrors.length > 0 ? removeErrors : undefined,
  });
}
