import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { sendLarkWebhook, buildLarkCardPayload } from "@/lib/lark/client";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/warehouses/[id]/test-lark
 *
 * Gửi 1 tin test vào webhook Lark của kho. Không đi qua orchestrator
 * notifyWarehouseIssue (nó gộp cửa sổ 5 phút → sẽ suppress tin test).
 *
 * Cross-tenant: warehouse fetch có .eq("organization_id", ctx.organizationId).
 * Nếu warehouseId thuộc org khác → 404, không gửi.
 *
 * Ghi notification_logs với event_type='connection_test' để phân biệt tin
 * thật vs tin test (query "thông báo gần nhất" phải loại loại này ra).
 * Cập nhật warehouses.notify_lark_last_test_at dù gửi thành công hay lỗi.
 */
export async function POST(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermissionStrict("warehouse.update");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const admin = createAdminClient();

  // Lấy warehouse + verify org (cross-tenant guard).
  const { data: wh, error: whErr } = await admin
    .from("warehouses")
    .select("id, name, notify_lark_webhook_url, notify_lark_enabled")
    .eq("id", id)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (whErr) {
    return NextResponse.json({ error: "lookup_failed", message: whErr.message }, { status: 500 });
  }
  if (!wh) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!wh.notify_lark_webhook_url) {
    return NextResponse.json(
      { error: "no_webhook", message: "Kho chưa cấu hình webhook Lark." },
      { status: 400 },
    );
  }

  const now = new Date();

  // Build tin test — card interactive, cùng shape với tin thật để verify format
  // Lark chấp nhận đúng.
  const cardPayload = buildLarkCardPayload({
    title: `[${wh.name}] Test kết nối`,
    bodyLines: [
      "**Thời điểm:** " + now.toLocaleString("vi-VN"),
      "**Nội dung:** Đây là tin thử kết nối từ trang Cấu hình thông báo.",
      "_Nếu bạn thấy tin này = webhook hoạt động bình thường._",
    ],
    actionUrl: null,
    actionLabel: "",
  });

  // Gửi thẳng, không qua orchestrator (không gộp cửa sổ).
  const sendResult = await sendLarkWebhook(wh.notify_lark_webhook_url, cardPayload);

  const finalStatus = sendResult.ok ? "sent" : "failed";

  // Ghi log — window_start = now (không quan trọng với connection_test vì
  // không cần UNIQUE cửa sổ; UNIQUE index chỉ áp cho pending/sent/failed
  // packing_issue_*. connection_test có thể spam log thoải mái).
  await admin.from("notification_logs").insert({
    organization_id: ctx.organizationId,
    warehouse_id: id,
    channel: "lark",
    event_type: "connection_test",
    window_start: now.toISOString(),
    status: finalStatus,
    message: "Test kết nối thủ công từ dashboard",
    waybill_code: null,
    suppressed_count: 0,
    error_message: sendResult.error,
    response_status: sendResult.responseStatus,
    response_body: sendResult.responseBody,
  });

  // Cập nhật timestamp test cuối (dù thành công hay lỗi).
  await admin
    .from("warehouses")
    .update({ notify_lark_last_test_at: now.toISOString() })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);

  if (!sendResult.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "lark_send_failed",
        message: sendResult.error ?? "Không gửi được tin test",
        response_status: sendResult.responseStatus,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    response_status: sendResult.responseStatus,
    tested_at: now.toISOString(),
  });
}
