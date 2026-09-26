import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { SYSTEM_JOB_SYSTEM_CHECK } from "@/lib/system/alert";
import { listIncidents, parseStatusFilter } from "@/lib/system/incident-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// GET /api/platform/incidents?status=active|resolved|all&org=<id>|system
// — trang Sự cố: sổ của MỌI kho (kế hoạch VAN-HANH-NHIEU-KHO, đợt 4).
//
// Chỉ đọc sổ, KHÔNG chạy mục kiểm: sổ do lượt tự kiểm nền ghi. Trả kèm mốc
// lượt tự kiểm gần nhất — sổ rỗng khi con tự kiểm chết không có nghĩa là khoẻ.
// ============================================================================
export async function GET(req: Request) {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(req.url);
  const status = parseStatusFilter(url.searchParams.get("status"));
  const orgId = url.searchParams.get("org") || null;

  const admin = createAdminClient();
  const [list, orgsRes, lastRunRes] = await Promise.all([
    listIncidents(admin, { status, orgId }),
    admin.from("organizations").select("id, name").order("name"),
    admin
      .from("system_jobs")
      .select("ran_at")
      .eq("job_name", SYSTEM_JOB_SYSTEM_CHECK)
      .order("ran_at", { ascending: false })
      .limit(1),
  ]);

  if (!list.ok) {
    return NextResponse.json(
      {
        error: list.missingTable ? "ledger_missing" : "db_error",
        message: list.missingTable
          ? "Chưa có bảng sổ sự cố — cần chạy migration 20260926100000."
          : `Không đọc được sổ sự cố: ${list.message}`,
      },
      { status: list.missingTable ? 503 : 500 },
    );
  }

  // Tên người ghi nhận — vài người, gọi từng người là đủ.
  const ackIds = [...new Set(list.rows.map((r) => r.acknowledged_by).filter((v): v is string => !!v))];
  const ackEmails: Record<string, string | null> = {};
  await Promise.all(
    ackIds.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      ackEmails[id] = data?.user?.email ?? null;
    }),
  );

  return NextResponse.json({
    incidents: list.rows.map((r) => ({
      ...r,
      acknowledged_by_email: r.acknowledged_by ? ackEmails[r.acknowledged_by] ?? null : null,
    })),
    orgs: (orgsRes.data ?? []) as Array<{ id: string; name: string }>,
    lastBackgroundRun: (lastRunRes.data as Array<{ ran_at: string }> | null)?.[0]?.ran_at ?? null,
    filter: { status, org: orgId },
  });
}
