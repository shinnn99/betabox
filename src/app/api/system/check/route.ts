import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyBearerSecret } from "@/lib/secure-compare";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSystemChecks, worstStatus } from "@/lib/system/checks";
import { SYSTEM_JOB_SYSTEM_CHECK, sendSystemAlert } from "@/lib/system/alert";
import { errorMessage, recordSystemJob } from "@/lib/system/job-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tự kiểm hạ tầng + gửi cảnh báo. systemd timer trên VPS gọi mỗi 15 phút:
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        https://betabox.betacom.agency/api/system/check
 *
 * Xác thực bằng CRON_SECRET (cùng secret với cron dọn clip, cùng nguồn
 * /etc/betabox-cron.env). Không session, không cookie.
 *
 * Route này KHÔNG BAO GIỜ 500 vì một mục kiểm hỏng: mỗi mục tự bọc lỗi
 * thành `unknown` (xem safeCheck trong checks.ts). Một hệ theo dõi trả 500
 * là một hệ theo dõi cần người theo dõi nó.
 */
export async function POST(request: NextRequest) {
  if (!verifyBearerSecret(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const now = new Date();

  // Một client dùng chung cho cả kiểm, chống spam và ghi sổ — nếu tạo
  // không được thì các mục dùng DB tự trả unknown, route vẫn trả 200.
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch (err) {
    console.error("[system-check] không tạo được admin client:", errorMessage(err));
  }

  // Chỉ lấy `checks`: đường cảnh báo cố ý KHÔNG đọc phần chi tiết theo kho
  // mà runSystemChecks trả kèm — nó chỉ phục vụ trang hiển thị.
  const { checks } = await runSystemChecks({ client: admin ?? undefined, now });
  const worst = worstStatus(checks);

  const base = process.env.NEXT_PUBLIC_APP_URL ?? null;
  let alert: Awaited<ReturnType<typeof sendSystemAlert>> = {
    alerted: [],
    sent: null,
    error: admin ? null : "không có kết nối Supabase để đọc lịch sử chống spam",
  };
  if (admin) {
    try {
      alert = await sendSystemAlert({
        admin,
        checks,
        now,
        // /platform/system, KHÔNG phải /dashboard/system: platform admin
        // không có organization_id trong JWT nên middleware đá họ khỏi
        // /dashboard/* — nút trong tin Lark sẽ dẫn vào chỗ không mở được.
        dashboardUrl: base ? `${base}/platform/system` : null,
      });
    } catch (err) {
      // sendSystemAlert đã hứa không throw; bọc thêm ở đây để lời hứa đó
      // hỏng cũng không kéo mất dòng sổ bên dưới.
      alert = { alerted: [], sent: false, error: errorMessage(err) };
    }
  }

  // Dòng sổ này phục vụ HAI việc: mốc "syscheck còn sống", và trí nhớ
  // chống spam của lần chạy sau (detail.alerted).
  await recordSystemJob(
    {
      jobName: SYSTEM_JOB_SYSTEM_CHECK,
      // ok=false chỉ khi việc GỬI hỏng. Mục kiểm đỏ không phải lỗi của
      // job — job làm đúng việc của nó là phát hiện ra.
      ok: alert.sent !== false,
      durationMs: Date.now() - startedAt,
      detail: {
        worst,
        checks: checks.map((c) => ({ key: c.key, status: c.status })),
        alerted: alert.alerted,
        sent: alert.sent,
        error: alert.error,
      },
    },
    { client: admin ?? undefined },
  );

  return NextResponse.json({
    ok: true,
    checked_at: now.toISOString(),
    worst,
    checks,
    alert: { sent: alert.sent, alerted: alert.alerted, error: alert.error },
  });
}
