import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";

export const runtime = "nodejs";

/**
 * GET /api/warehouses/notifications-overview
 *
 * Trả danh sách kho + thông tin Lark cho trang Cấu hình thông báo:
 *   - notify_lark_webhook_url + notify_lark_enabled + notify_lark_last_test_at
 *   - has_recent_failure: true nếu notification_logs có row 'failed' trong
 *     15 phút gần nhất (event_type gồm cả packing_issue_* và connection_test).
 *   - last_notification: tin gần nhất event_type=packing_issue_* (KHÔNG kể
 *     connection_test) — dùng cho cột "Thông báo gần nhất".
 *
 * Cross-tenant: filter theo ctx.organizationId ở mọi query.
 */
export async function GET() {
  const ctx = await requirePermission("warehouse.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();

  // 1. Warehouses của org.
  const { data: warehouses, error: whErr } = await admin
    .from("warehouses")
    .select(
      "id, code, name, status, notify_lark_webhook_url, notify_lark_enabled, notify_lark_last_test_at, notify_lark_digest_daily, notify_lark_digest_weekly, notify_lark_digest_monthly",
    )
    .eq("organization_id", ctx.organizationId)
    .order("code");
  if (whErr) return NextResponse.json({ error: whErr.message }, { status: 500 });
  if (!warehouses) return NextResponse.json({ warehouses: [] });

  const whIds = warehouses.map((w) => w.id as string);
  if (whIds.length === 0) return NextResponse.json({ warehouses: [] });

  // 2. Tin gần nhất mỗi warehouse — packing_issue_* only (tin thật, không test).
  //    Query đơn giản: lấy tối đa 100 row gần nhất, groupby ở JS.
  //    Không lo scale — 24 kho × vài event/ngày.
  const { data: recentNotifs } = await admin
    .from("notification_logs")
    .select("warehouse_id, event_type, status, waybill_code, sent_at")
    .eq("organization_id", ctx.organizationId)
    .in("warehouse_id", whIds)
    .in("event_type", [
      "packing_issue_duplicated",
      "packing_issue_no_active_session",
      "packing_issue_unmapped_scanner",
      "packing_issue_invalid_code",
    ])
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(100);

  const latestByWh = new Map<string, {
    event_type: string;
    waybill_code: string | null;
    sent_at: string;
  }>();
  for (const n of recentNotifs ?? []) {
    const nr = n as { warehouse_id: string; event_type: string; waybill_code: string | null; sent_at: string };
    if (!latestByWh.has(nr.warehouse_id)) {
      latestByWh.set(nr.warehouse_id, {
        event_type: nr.event_type,
        waybill_code: nr.waybill_code,
        sent_at: nr.sent_at,
      });
    }
  }

  // 3. Kho có failure gần đây → badge "Lỗi webhook".
  //
  // Rule (fix 2026-07-24): chỉ đỏ khi TIN CUỐI CÙNG (per warehouse, mọi
  // event_type) trong 15 phút là 'failed'. Nếu sau failed có sent (VD Hạnh
  // fix cấu hình rồi test lại thành công) → coi như đã sửa, không báo đỏ.
  //
  // Trước đây: chỉ cần có 1 row 'failed' trong 15p → đỏ. Kích lỗi UX khi
  // Hạnh vừa fix xong test 2 lần thành công mà badge vẫn đỏ 15p.
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: recentAny } = await admin
    .from("notification_logs")
    .select("warehouse_id, status, sent_at")
    .eq("organization_id", ctx.organizationId)
    .in("warehouse_id", whIds)
    .in("status", ["sent", "failed"])
    .gte("sent_at", fifteenMinAgo)
    .order("sent_at", { ascending: false });

  const latestStatusByWh = new Map<string, string>();
  for (const r of recentAny ?? []) {
    const rr = r as { warehouse_id: string; status: string };
    if (!latestStatusByWh.has(rr.warehouse_id)) {
      latestStatusByWh.set(rr.warehouse_id, rr.status);
    }
  }
  const failedWhIds = new Set<string>();
  for (const [whId, status] of latestStatusByWh) {
    if (status === "failed") failedWhIds.add(whId);
  }

  // Ghép kết quả.
  const result = warehouses.map((w) => {
    const wr = w as {
      id: string;
      code: string;
      name: string;
      status: string;
      notify_lark_webhook_url: string | null;
      notify_lark_enabled: boolean;
      notify_lark_last_test_at: string | null;
      notify_lark_digest_daily: boolean;
      notify_lark_digest_weekly: boolean;
      notify_lark_digest_monthly: boolean;
    };
    return {
      ...wr,
      has_recent_failure: failedWhIds.has(wr.id),
      last_notification: latestByWh.get(wr.id) ?? null,
    };
  });

  return NextResponse.json({ warehouses: result });
}
