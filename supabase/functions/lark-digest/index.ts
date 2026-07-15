// Supabase Edge Function — lark-digest.
//
// Chạy trên Deno runtime. Được gọi bởi pg_cron 3 lần:
//   - Daily 22:00 VN (15:00 UTC) — body { period: "daily" }
//   - Weekly thứ 2 08:00 VN (thứ 2 01:00 UTC) — body { period: "weekly" }
//   - Monthly ngày 1 08:00 VN (ngày 1 01:00 UTC) — body { period: "monthly" }
//
// Vì sao Edge Function chứ không Vercel route:
//   - Vercel Hobby: hết slot cron (đang dùng cho cleanup-clips daily 3:00).
//   - Vercel serverless: lambda có thể kill giữa fetch, cần after() workaround.
//     Edge Function Deno chạy đủ lâu để hoàn thành fetch Lark từng kho.
//   - pg_cron gọi thẳng Edge Function qua HTTP, không bị bug BetacomEdu
//     (hardcode success=true khi enqueue pg_net) vì Edge Function await
//     fetch Lark thật + check body.
//
// Authentication: pg_cron gọi với header `Authorization: Bearer <secret>` —
// khớp với env DIGEST_SECRET của function. Kiểm secret trước khi làm gì.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ============================================================================
// Types (khớp với LARK_CONFIG trong TS backend chính)
// ============================================================================

interface DigestRequest {
  period: "daily" | "weekly" | "monthly";
}

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  organization_id: string;
  notify_lark_webhook_url: string;
  notify_lark_digest_daily: boolean;
  notify_lark_digest_weekly: boolean;
  notify_lark_digest_monthly: boolean;
}

interface StaffAgg {
  staff_id: string | null;
  staff_code: string | null;
  full_name: string;
  total: number;
  duplicated: number;
  no_active_session: number;
  unmapped_scanner: number;
  invalid_code: number;
  manual_error: number;
  issues_total: number;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const LARK_FETCH_TIMEOUT_MS = 10_000;
const MAX_STAFF_LISTED = 15; // Cap để tin không phình khi kho có 50+ nhân sự.

// ============================================================================
// Time window — VN timezone (UTC+7)
// ============================================================================

/**
 * Tính window [from, to) UTC cho period, tính theo VN timezone.
 * - daily: từ 00:00 VN hôm nay → 00:00 VN NGÀY MAI. Gọi lúc 22:00 = tổng
 *   hợp cả ngày hôm nay (không bao gồm 2 tiếng cuối 22-24h). Chấp nhận.
 *   Nếu cần trọn ngày, đổi cron sang 00:05 VN của NGÀY MAI + shift period lùi.
 * - weekly: thứ 2 → thứ 2 tuần trước, kết thúc = thứ 2 tuần này.
 * - monthly: ngày 1 tháng trước → ngày 1 tháng này.
 */
function computeWindow(period: "daily" | "weekly" | "monthly"): {
  from: Date;
  to: Date;
  label: string;
} {
  // VN offset = +7h. Now UTC + 7h = VN time.
  const nowUtc = new Date();
  const vnOffsetMs = 7 * 60 * 60 * 1000;
  const nowVn = new Date(nowUtc.getTime() + vnOffsetMs);

  if (period === "daily") {
    // Window = ngày hôm nay theo VN. Start = 00:00 VN. End = 00:00 VN ngày mai.
    const startVn = new Date(nowVn);
    startVn.setUTCHours(0, 0, 0, 0);
    const endVn = new Date(startVn);
    endVn.setUTCDate(endVn.getUTCDate() + 1);
    const startUtc = new Date(startVn.getTime() - vnOffsetMs);
    const endUtc = new Date(endVn.getTime() - vnOffsetMs);
    return {
      from: startUtc,
      to: endUtc,
      label: `Ngày ${formatDate(startVn)}`,
    };
  }

  if (period === "weekly") {
    // Chạy thứ 2 08:00 VN → tổng hợp tuần TRƯỚC (thứ 2 tuần trước → CN cuối tuần).
    // Thứ 2 tuần này 00:00 VN = end. Thứ 2 tuần trước 00:00 VN = start.
    const dow = nowVn.getUTCDay(); // 0 = CN, 1 = T2
    const daysBackToMonday = dow === 0 ? 6 : dow - 1;
    const thisMondayVn = new Date(nowVn);
    thisMondayVn.setUTCHours(0, 0, 0, 0);
    thisMondayVn.setUTCDate(thisMondayVn.getUTCDate() - daysBackToMonday);
    const lastMondayVn = new Date(thisMondayVn);
    lastMondayVn.setUTCDate(lastMondayVn.getUTCDate() - 7);
    return {
      from: new Date(lastMondayVn.getTime() - vnOffsetMs),
      to: new Date(thisMondayVn.getTime() - vnOffsetMs),
      label: `Tuần ${formatDate(lastMondayVn)} → ${formatDate(new Date(thisMondayVn.getTime() - 86400000))}`,
    };
  }

  // monthly: chạy ngày 1 08:00 VN → tổng hợp tháng TRƯỚC.
  const firstOfThisMonthVn = new Date(nowVn);
  firstOfThisMonthVn.setUTCHours(0, 0, 0, 0);
  firstOfThisMonthVn.setUTCDate(1);
  const firstOfLastMonthVn = new Date(firstOfThisMonthVn);
  firstOfLastMonthVn.setUTCMonth(firstOfLastMonthVn.getUTCMonth() - 1);
  return {
    from: new Date(firstOfLastMonthVn.getTime() - vnOffsetMs),
    to: new Date(firstOfThisMonthVn.getTime() - vnOffsetMs),
    label: `Tháng ${(firstOfLastMonthVn.getUTCMonth() + 1).toString().padStart(2, "0")}/${firstOfLastMonthVn.getUTCFullYear()}`,
  };
}

function formatDate(d: Date): string {
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ============================================================================
// Build Lark card — user sẽ sửa format sau, làm gọn đủ dùng trước.
// ============================================================================

function buildDigestCard(input: {
  warehouseName: string;
  periodLabel: string;
  period: "daily" | "weekly" | "monthly";
  perStaff: StaffAgg[];
}): object {
  const periodTitle = {
    daily: "Báo cáo ngày",
    weekly: "Báo cáo tuần",
    monthly: "Báo cáo tháng",
  }[input.period];

  // Tổng toàn kho.
  const totals = input.perStaff.reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      duplicated: acc.duplicated + s.duplicated,
      no_active_session: acc.no_active_session + s.no_active_session,
      unmapped_scanner: acc.unmapped_scanner + s.unmapped_scanner,
      invalid_code: acc.invalid_code + s.invalid_code,
      manual_error: acc.manual_error + s.manual_error,
      issues_total: acc.issues_total + s.issues_total,
    }),
    {
      total: 0,
      duplicated: 0,
      no_active_session: 0,
      unmapped_scanner: 0,
      invalid_code: 0,
      manual_error: 0,
      issues_total: 0,
    },
  );

  // Bảng per staff (top N).
  const shown = input.perStaff.slice(0, MAX_STAFF_LISTED);
  const rest = Math.max(0, input.perStaff.length - shown.length);

  // Metric fields — Lark render 2 cột song song khi is_short=true.
  const metricFields = [
    {
      is_short: true,
      text: { tag: "lark_md", content: `**📦 Tổng đơn**\n${totals.total}` },
    },
    {
      is_short: true,
      text: { tag: "lark_md", content: `**⚠️ Tổng lỗi**\n${totals.issues_total}` },
    },
  ];

  // Chi tiết loại lỗi — chỉ hiện các loại > 0 để card gọn khi ngày sạch.
  const errorBreakdown: string[] = [];
  if (totals.duplicated > 0) errorBreakdown.push(`• Đơn trùng: **${totals.duplicated}**`);
  if (totals.no_active_session > 0) errorBreakdown.push(`• Không có ca: **${totals.no_active_session}**`);
  if (totals.unmapped_scanner > 0) errorBreakdown.push(`• Máy quét chưa gán: **${totals.unmapped_scanner}**`);
  if (totals.invalid_code > 0) errorBreakdown.push(`• Mã lỗi: **${totals.invalid_code}**`);
  if (totals.manual_error > 0) errorBreakdown.push(`• Đánh dấu tay: **${totals.manual_error}**`);
  const errorSection = errorBreakdown.length > 0
    ? errorBreakdown.join("\n")
    : "_Không có đơn lỗi nào trong kỳ này._ 🎉";

  // Chi tiết theo nhân sự.
  const staffLines: string[] = [];
  if (shown.length === 0) {
    staffLines.push("_Không có dữ liệu nhân sự trong kỳ này._");
  } else {
    for (const s of shown) {
      const name = s.staff_code
        ? `${s.full_name} (${s.staff_code})`
        : s.full_name;
      const errorParts: string[] = [];
      if (s.duplicated > 0) errorParts.push(`${s.duplicated} trùng`);
      if (s.manual_error > 0) errorParts.push(`${s.manual_error} tay`);
      const otherErrors = s.no_active_session + s.unmapped_scanner + s.invalid_code;
      if (otherErrors > 0) errorParts.push(`${otherErrors} khác`);
      const errorSummary = errorParts.length > 0
        ? ` — lỗi **${s.issues_total}** (${errorParts.join(", ")})`
        : "";
      staffLines.push(`**${name}**\n${s.total} đơn${errorSummary}`);
    }
    if (rest > 0) {
      staffLines.push(`_...và ${rest} nhân sự khác_`);
    }
  }

  const elements: object[] = [
    // Header info: label kỳ.
    {
      tag: "div",
      text: { tag: "lark_md", content: `📅 **${input.periodLabel}**` },
    },
    // Metric grid 2 cột.
    {
      tag: "div",
      fields: metricFields,
    },
    { tag: "hr" },
    // Breakdown loại lỗi.
    {
      tag: "div",
      text: { tag: "lark_md", content: `**Chi tiết loại lỗi**\n${errorSection}` },
    },
    { tag: "hr" },
    // Chi tiết nhân sự.
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**👥 Chi tiết theo nhân sự** _(sắp xếp theo số lỗi giảm dần)_\n\n${staffLines.join("\n\n")}`,
      },
    },
  ];

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: {
          tag: "plain_text",
          content: `[${input.warehouseName}] ${periodTitle}`,
        },
        template: "blue",
      },
      elements,
    },
  };
}

// ============================================================================
// Send Lark webhook — parse body Đường B (code === 0 = success)
// ============================================================================

async function sendLark(
  webhookUrl: string,
  payload: object,
): Promise<{ ok: boolean; status: number | null; body: string; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LARK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await res.text().catch(() => "");
    const bodyTrimmed = bodyText.slice(0, 2000);
    if (!res.ok) {
      return { ok: false, status: res.status, body: bodyTrimmed, error: `http_${res.status}` };
    }
    // Parse body — code === 0 là success (Đường B).
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object" && "code" in parsed) {
        const code = parsed.code;
        if (typeof code === "number" && code !== 0) {
          const msg = typeof parsed.msg === "string" ? parsed.msg : "unknown";
          return { ok: false, status: res.status, body: bodyTrimmed, error: `lark_code_${code}: ${msg}` };
        }
      }
    } catch {
      // Body không JSON — fallback HTTP status OK.
    }
    return { ok: true, status: res.status, body: bodyTrimmed, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, body: "", error: `fetch_error: ${msg.slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Main handler
// ============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Auth: pg_cron gọi với Bearer secret.
  const expectedSecret = Deno.env.get("DIGEST_SECRET");
  const authHeader = req.headers.get("authorization") ?? "";
  if (!expectedSecret) {
    return json({ error: "missing_env_DIGEST_SECRET" }, 500);
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: DigestRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const period = body.period;
  if (period !== "daily" && period !== "weekly" && period !== "monthly") {
    return json({ error: "invalid_period" }, 400);
  }

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supaUrl || !serviceKey) {
    return json({ error: "missing_supabase_env" }, 500);
  }
  const admin = createClient(supaUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const window = computeWindow(period);

  // Lấy các kho đã bật digest cho period này.
  const configField =
    period === "daily"
      ? "notify_lark_digest_daily"
      : period === "weekly"
        ? "notify_lark_digest_weekly"
        : "notify_lark_digest_monthly";

  const { data: warehouses, error: whErr } = await admin
    .from("warehouses")
    .select(
      "id, code, name, organization_id, notify_lark_webhook_url, notify_lark_digest_daily, notify_lark_digest_weekly, notify_lark_digest_monthly, notify_lark_enabled",
    )
    .eq(configField, true)
    .eq("notify_lark_enabled", true)
    .not("notify_lark_webhook_url", "is", null);

  if (whErr) {
    return json({ error: "warehouse_lookup_failed", message: whErr.message }, 500);
  }

  const results: Array<{ warehouse_id: string; code: string; ok: boolean; error: string | null }> = [];

  for (const w of (warehouses ?? []) as WarehouseRow[]) {
    // Query aggregate per staff cho warehouse này.
    const { data: perStaff, error: rpcErr } = await admin.rpc(
      "lark_digest_per_staff",
      {
        p_warehouse_id: w.id,
        p_from: window.from.toISOString(),
        p_to: window.to.toISOString(),
      },
    );
    if (rpcErr) {
      results.push({ warehouse_id: w.id, code: w.code, ok: false, error: `rpc: ${rpcErr.message}` });
      continue;
    }

    const rows = (perStaff ?? []) as StaffAgg[];
    const cardPayload = buildDigestCard({
      warehouseName: w.name,
      periodLabel: window.label,
      period,
      perStaff: rows,
    });

    const sendResult = await sendLark(w.notify_lark_webhook_url, cardPayload);

    // Ghi notification_logs.
    await admin.from("notification_logs").insert({
      organization_id: w.organization_id,
      warehouse_id: w.id,
      channel: "lark",
      event_type: `digest_${period}`,
      window_start: window.from.toISOString(),
      status: sendResult.ok ? "sent" : "failed",
      message: `Digest ${period} — ${window.label} — ${rows.length} nhân sự`,
      waybill_code: null,
      suppressed_count: rows.length,
      error_message: sendResult.error,
      response_status: sendResult.status,
      response_body: sendResult.body,
    });

    results.push({
      warehouse_id: w.id,
      code: w.code,
      ok: sendResult.ok,
      error: sendResult.error,
    });
  }

  return json({
    ok: true,
    period,
    window: { from: window.from.toISOString(), to: window.to.toISOString(), label: window.label },
    warehouses_processed: results.length,
    results,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
