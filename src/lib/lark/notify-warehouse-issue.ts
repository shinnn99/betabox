import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LARK_CONFIG, windowStartFor } from "./config.ts";
import { sendLarkWebhook, buildLarkCardPayload } from "./client.ts";
import { buildMessageParts, type LarkEventType } from "./messages.ts";

// Orchestrator gộp cửa sổ + verify org + gửi Lark + log.
//
// CHỖ DUY NHẤT có thể rò cross-tenant. Verify script nhắm vào file này.
//
// Nguyên tắc cứng:
//   1. Lấy warehouse trong CÙNG org của sự kiện — không tin warehouse_id trần.
//   2. Fail-safe im lặng: kho không config → log status='disabled', KHÔNG throw.
//   3. Fire-and-forget: caller void Promise, không await — không chặn hot path.
//   4. Gộp cửa sổ qua UNIQUE (warehouse, event_type, window_start) —
//      INSERT thành công = cửa sổ mới, gửi. Duplicate = suppress + đếm.
//   5. suppressedInPreviousWindow: đếm suppressed của cửa sổ TRƯỚC, đưa vào
//      tin đầu cửa sổ mới ("5 phút qua còn N đơn khác").

export interface NotifyInput {
  admin: SupabaseClient;
  organizationId: string;
  warehouseId: string;
  eventType: LarkEventType;
  waybillCode: string | null;
  scannedAtIso: string;
}

type NotifyOutcome =
  | { kind: "sent" }
  | { kind: "suppressed" }
  | { kind: "disabled"; reason: string }
  | { kind: "failed"; error: string }
  | { kind: "skipped_cross_tenant" };

export async function notifyWarehouseIssue(
  input: NotifyInput,
): Promise<NotifyOutcome> {
  const { admin, organizationId, warehouseId, eventType } = input;

  // Kill switch env.
  if (!LARK_CONFIG.enabled) {
    return { kind: "disabled", reason: "env_kill_switch" };
  }

  // ------------------------------------------------------------------
  // 1. Lấy warehouse trong CÙNG org — NƯỚC RÀO CHẮN CROSS-TENANT.
  //    .eq("organization_id", organizationId) là dòng cứng nhất file này.
  //    Nếu warehouseId thuộc org khác → maybeSingle() trả null → return
  //    skipped_cross_tenant. KHÔNG bao giờ đọc webhook của org khác.
  // ------------------------------------------------------------------
  const { data: wh, error: whErr } = await admin
    .from("warehouses")
    .select("id, name, notify_lark_webhook_url, notify_lark_enabled")
    .eq("id", warehouseId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (whErr) {
    // Không log vào notification_logs (chưa biết warehouse hợp lệ) — chỉ
    // console log. Không throw.
    console.error(
      `[lark] warehouse lookup failed org=${organizationId} wh=${warehouseId}: ${whErr.message}`,
    );
    return { kind: "failed", error: `wh_lookup: ${whErr.message}` };
  }

  if (!wh) {
    // Warehouse không thuộc org này (hoặc không tồn tại). Đây là tín hiệu
    // cross-tenant hoặc bug caller — KHÔNG gửi, KHÔNG log (không có warehouse
    // hợp lệ để log về). Verify script bắt outcome này.
    console.warn(
      `[lark] cross-tenant guard: org=${organizationId} wh=${warehouseId} not found in org`,
    );
    return { kind: "skipped_cross_tenant" };
  }

  const now = new Date();
  const windowStart = windowStartFor(now);
  const windowStartIso = windowStart.toISOString();

  // ------------------------------------------------------------------
  // 2. Kho chưa cấu hình / tắt → log 'disabled', không gửi.
  //    'disabled' KHÔNG chiếm slot UNIQUE (partial index WHERE status IN
  //    sent/failed/suppressed) → khi kho bật lại giữa cửa sổ, tin mới đi
  //    được ngay.
  // ------------------------------------------------------------------
  if (!wh.notify_lark_enabled || !wh.notify_lark_webhook_url) {
    await admin.from("notification_logs").insert({
      organization_id: organizationId,
      warehouse_id: warehouseId,
      channel: "lark",
      event_type: eventType,
      window_start: windowStartIso,
      status: "disabled",
      message: null,
      waybill_code: input.waybillCode,
      suppressed_count: 0,
      error_message: !wh.notify_lark_webhook_url
        ? "no_webhook_configured"
        : "warehouse_notify_disabled",
    });
    return {
      kind: "disabled",
      reason: !wh.notify_lark_webhook_url ? "no_webhook" : "warehouse_off",
    };
  }

  // ------------------------------------------------------------------
  // 3. Claim cửa sổ qua UNIQUE index (pattern consumeNonce).
  //    INSERT với status='sent' preemptively; nếu duplicate → cửa sổ đã có
  //    tin, chuyển sang suppress path.
  //    Race 2 request đồng thời cùng cửa sổ: chỉ 1 win (INSERT), request
  //    còn lại nhận 23505 → suppress.
  // ------------------------------------------------------------------
  // Lấy DANH SÁCH waybill của suppressed cửa sổ TRƯỚC — để tin hiện tại
  // liệt kê mã cụ thể (hành động được), không chỉ đếm số.
  // Đọc CỘT waybill_code (không parse text `message`) — đổi format tin sau
  // này không vỡ chỗ này.
  const prevWindowStart = new Date(
    windowStart.getTime() - LARK_CONFIG.windowSeconds * 1000,
  );
  const { data: prevSuppressedRows } = await admin
    .from("notification_logs")
    .select("waybill_code")
    .eq("warehouse_id", warehouseId)
    .eq("event_type", eventType)
    .eq("window_start", prevWindowStart.toISOString())
    .eq("status", "suppressed")
    .order("sent_at", { ascending: true });

  const suppressedWaybills = (prevSuppressedRows ?? [])
    .map((r) => (r as { waybill_code: string | null }).waybill_code)
    .filter((c): c is string => typeof c === "string" && c.length > 0);

  const dashboardUrl = LARK_CONFIG.dashboardBaseUrl
    ? `${LARK_CONFIG.dashboardBaseUrl}/dashboard/videos`
    : null;

  const parts = buildMessageParts({
    eventType,
    warehouseName: wh.name ?? "Kho",
    waybillCode: input.waybillCode,
    scannedAtIso: input.scannedAtIso,
    suppressedWaybillsInPreviousWindow: suppressedWaybills,
    dashboardUrl,
  });
  const cardPayload = buildLarkCardPayload({
    title: parts.title,
    bodyLines: parts.bodyLines,
    actionUrl: parts.actionUrl,
    actionLabel: parts.actionLabel,
  });

  // Claim slot — INSERT status='pending' TRƯỚC fetch. UPDATE thành 'sent'
  // (fetch OK) hoặc 'failed' (fetch lỗi) SAU fetch. Không ghi 'sent'
  // preemptive — nếu lambda kill giữa fetch, row kẹt 'pending' là bằng
  // chứng after() không cứu (đo trực tiếp trong verify vế 4).
  //
  // Race 2 request đồng thời cùng cửa sổ: UNIQUE (pending/sent/failed) chống
  // race — chỉ 1 win INSERT, còn lại 23505 → suppress.
  const { error: claimErr } = await admin
    .from("notification_logs")
    .insert({
      organization_id: organizationId,
      warehouse_id: warehouseId,
      channel: "lark",
      event_type: eventType,
      window_start: windowStartIso,
      status: "pending", // sẽ UPDATE thành sent/failed sau fetch
      message: parts.plainText, // lưu plain text để debug/log dễ đọc, không phải JSON card
      waybill_code: input.waybillCode,
      suppressed_count: suppressedWaybills.length,
    });

  if (claimErr) {
    // 23505 unique_violation → cửa sổ đã có tin (pending/sent/failed) → suppress.
    if ((claimErr as { code?: string }).code === "23505") {
      // Ghi row suppressed với waybill_code — cửa sổ sau đọc cột này để
      // liệt kê mã bị nén. Null-safe.
      await admin.from("notification_logs").insert({
        organization_id: organizationId,
        warehouse_id: warehouseId,
        channel: "lark",
        event_type: eventType,
        window_start: windowStartIso,
        status: "suppressed",
        message: null,
        waybill_code: input.waybillCode,
        suppressed_count: 0,
      });
      return { kind: "suppressed" };
    }
    console.error(
      `[lark] claim insert failed wh=${warehouseId}: ${claimErr.message}`,
    );
    return { kind: "failed", error: `claim: ${claimErr.message}` };
  }

  // ------------------------------------------------------------------
  // 4. Gửi Lark. Sau khi có kết quả → UPDATE row pending thành sent/failed.
  //    KHÔNG throw vào caller — hot path đã sau after() rồi.
  //    Nếu lambda kill giữa fetch → row kẹt 'pending' (bằng chứng đo).
  // ------------------------------------------------------------------
  const sendResult = await sendLarkWebhook(wh.notify_lark_webhook_url, cardPayload);
  const finalStatus = sendResult.ok ? "sent" : "failed";

  await admin
    .from("notification_logs")
    .update({
      status: finalStatus,
      error_message: sendResult.error,
      response_status: sendResult.responseStatus,
      response_body: sendResult.responseBody,
    })
    .eq("warehouse_id", warehouseId)
    .eq("event_type", eventType)
    .eq("window_start", windowStartIso)
    .eq("status", "pending");

  if (!sendResult.ok) {
    return { kind: "failed", error: sendResult.error ?? "unknown" };
  }
  return { kind: "sent" };
}
