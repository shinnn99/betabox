import { NextResponse } from "next/server";
import { requirePlatformRole } from "@/lib/supabase/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHECK_CONFIG, runSystemChecks, worstStatus } from "@/lib/system/checks";
import {
  buildHeroStats,
  buildInfraTiles,
  buildIssues,
  buildOrgHealth,
  unavailableChecks,
} from "@/lib/system/status-view";
import { SYSTEM_JOB_SYSTEM_CHECK } from "@/lib/system/alert";
import { errorMessage } from "@/lib/system/job-log";
import { readOpenIncidents, type IncidentLedgerView } from "@/lib/system/incidents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/system/status — cùng 6 mục kiểm với /api/system/check, nhưng
 * KHÔNG gửi cảnh báo và KHÔNG ghi sổ. Chỉ đọc, cho trang /platform/system.
 *
 * HAI LỚP BẢO VỆ, cố ý:
 *   1. Proxy (middleware): route này KHÔNG nằm trong PUBLIC_API_PREFIXES,
 *      nên request không có session hợp lệ bị chặn từ vòng ngoài với
 *      {"error":"unauthenticated"} — không bao giờ chạm tới đây.
 *   2. requirePlatformRole: khách thuê (kể cả owner của org) dừng ở đây với
 *      {"error":"forbidden_platform_only"}. Đây là dữ liệu hạ tầng nội bộ
 *      Betacom — dung lượng ổ VPS, tên agent của MỌI kho, mã camera của
 *      MỌI khách. Không org nào được nhìn.
 *
 * KHÔNG dùng requirePermission*: platform admin không có organization_id
 * trong JWT nên hàm đó sẽ 403 họ. Đây cũng là lý do trang nằm ở /platform
 * chứ không /dashboard — xem ghi chú ở src/app/platform/system/page.tsx.
 */
export async function GET() {
  const ctx = await requirePlatformRole("platform_support");
  if (ctx instanceof NextResponse) return ctx;

  const now = new Date();
  const { checks, scope } = await runSystemChecks({ now });

  // Mốc "con cảnh báo nền còn sống không" — thứ mà bản thân trang này
  // không tự trả lời được: trang xanh nhưng timer chết thì vẫn mù.
  //
  // Đo luôn độ trễ của chính hai truy vấn này làm số Supabase cho dãy ô hạ
  // tầng: một round-trip THẬT trong lượt này, không phải trung bình bịa.
  let lastBackgroundRun: string | null = null;
  let selfCheckRuns24h: number | null = null;
  let supabaseLatencyMs: number | null = null;
  try {
    const admin = createAdminClient();
    const startedAt = Date.now();
    const sinceIso = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const [latest, recent] = await Promise.all([
      admin
        .from("system_jobs")
        .select("ran_at")
        .eq("job_name", SYSTEM_JOB_SYSTEM_CHECK)
        .order("ran_at", { ascending: false })
        .limit(1)
        .abortSignal(AbortSignal.timeout(CHECK_CONFIG.queryTimeoutMs)),
      admin
        .from("system_jobs")
        .select("ran_at", { count: "exact", head: true })
        .eq("job_name", SYSTEM_JOB_SYSTEM_CHECK)
        .gte("ran_at", sinceIso)
        .abortSignal(AbortSignal.timeout(CHECK_CONFIG.queryTimeoutMs)),
    ]);
    supabaseLatencyMs = Date.now() - startedAt;
    lastBackgroundRun = (latest.data as Array<{ ran_at: string }> | null)?.[0]?.ran_at ?? null;
    // `head: true` nên không có data — chỉ có count. null count = đọc hụt,
    // và đọc hụt KHÔNG được hiển thị thành 0 lượt (0 nghĩa là timer chết).
    selfCheckRuns24h = recent.count ?? null;
  } catch (err) {
    // Không đọc được mốc không phải lý do làm hỏng cả trang.
    console.warn("[system-status] không đọc được lần chạy nền:", errorMessage(err));
  }

  const issues = buildIssues(checks, scope);

  // Sổ sự cố (đợt 3): trang CHỈ ĐỌC. Chỉ route tự kiểm nền được ghi — trang
  // mà ghi thì mỗi người mở trang đẻ ra một lượt ghi, lại chạy đua nhau.
  let ledger: IncidentLedgerView = { available: false, reason: "Không tạo được kết nối Supabase." };
  try {
    ledger = await readOpenIncidents(createAdminClient());
  } catch (err) {
    ledger = { available: false, reason: errorMessage(err) };
  }

  // Gắn TÊN kho vào từng dòng sổ. Thiếu nó thì hai kho khác nhau có cùng
  // `where_label` (vd hai kho đều đặt tên bàn giống nhau) hiện ra y hệt nhau,
  // và người trực không biết phải gọi cho kho nào. Trang Sự cố có cột này rồi;
  // sổ nhúng ở đây trước giờ thì không.
  const ledgerWithOrgNames: IncidentLedgerView = ledger.available
    ? {
        ...ledger,
        open: ledger.open.map((i) => ({
          ...i,
          // Sự cố cấp hệ thống (cron, VPS) không thuộc kho nào — nói "Hệ thống"
          // chứ không để trống, vì ô trống đọc như dữ liệu bị thiếu.
          organization_name: i.organization_id
            ? (scope?.orgNameById.get(i.organization_id) ?? i.organization_id)
            : null,
        })),
      }
    : ledger;

  // Các tầng trang đọc, xếp theo thứ tự câu hỏi của người trực:
  //   hero        → "có phải làm gì không", sáu con số
  //   issues      → "đang hỏng cái gì, ở đâu, làm gì" (rỗng = không có việc)
  //   orgs        → "nhiều kho thì kho nào ra sao"
  //   infra       → hạ tầng chung, không thuộc kho nào
  //   unavailable → phần CHƯA theo dõi được, để không ai tưởng đã phủ hết
  //
  // `checks` vẫn trả nguyên vẹn: đó là bản đối chiếu với nội dung tin Lark.
  return NextResponse.json({
    ok: true,
    checked_at: now.toISOString(),
    worst: worstStatus(checks),
    checks,
    hero: buildHeroStats(checks, scope, issues),
    issues,
    orgs: buildOrgHealth(checks, scope),
    infra: buildInfraTiles(checks, {
      selfCheckRuns24h,
      // 24 giờ / 15 phút. Đổi nhịp timer thì đổi số này.
      selfCheckExpected24h: 96,
      supabaseLatencyMs,
    }),
    unavailable: unavailableChecks(checks),
    last_background_run: lastBackgroundRun,
    incidents: ledgerWithOrgNames,
  });
}
