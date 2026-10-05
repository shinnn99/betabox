import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { readStorageUsage } from "@/lib/system/storage-usage";
import { SYSTEM_JOB_CLEANUP_CLIPS } from "@/lib/system/job-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/platform/storage — dung lượng video đang nằm trên Supabase Storage.
//
// Chỉ đọc. Dữ liệu hạ tầng nội bộ Betacom (bucket của MỌI khách) nên chặn ở
// `requirePlatformRole`, giống /api/system/status.
//
// Kèm mốc lượt dọn gần nhất: bucket là cache 72 giờ, nên con số dung lượng
// chỉ đọc được ĐÚNG khi biết lượt dọn còn sống. Cron chết thì bucket phình
// mà không có gì báo — trang phải nói ra được điều đó.
// ============================================================================
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const admin = createAdminClient();

  // Mốc dọn đọc riêng trong try/catch: chưa có bảng sổ job thì mất mốc, nhưng
  // KHÔNG được làm hỏng cả trang. (Builder của Supabase là PromiseLike, không
  // có .catch — phải bọc bằng try/catch chứ không nối chuỗi được.)
  const readLastCleanup = async () => {
    try {
      const { data } = await admin
        .from("system_jobs")
        .select("ran_at, ok, detail")
        .eq("job_name", SYSTEM_JOB_CLEANUP_CLIPS)
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ?? null;
    } catch {
      return null;
    }
  };

  const [usage, lastCleanup] = await Promise.all([readStorageUsage(admin), readLastCleanup()]);

  return NextResponse.json({
    usage,
    last_cleanup: lastCleanup
      ? {
          at: lastCleanup.ran_at as string,
          ok: lastCleanup.ok as boolean,
          deleted: (lastCleanup.detail as { deleted?: number } | null)?.deleted ?? null,
        }
      : null,
  });
}
