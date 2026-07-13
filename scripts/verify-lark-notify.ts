/**
 * Verify Lark notify orchestrator — 4 vế.
 *
 * Chạy: node --experimental-strip-types --env-file=.env.local scripts/verify-lark-notify.ts
 *
 * Đây là RÀO CHẮN cross-tenant + chống-spam trước khi hook vào hot path
 * warehouse/scans. Nếu fail → KHÔNG hook.
 *
 * 4 vế:
 *   1. NỬA DƯƠNG: ctx Betacom + wh Betacom (có webhook) → 1 call, URL đúng.
 *   2. NỬA ÂM CROSS-TENANT: ctx org A + wh org B → 0 call, outcome
 *      'skipped_cross_tenant'. LEAK = fail cứng.
 *   3. NỬA ÂM FAIL-SAFE: kho không config webhook → 0 call, KHÔNG throw,
 *      outcome 'disabled'.
 *   4. NỬA ÂM GỘP CỬA SỔ: 3 lỗi cùng (wh, event) trong 1 cửa sổ → CHỈ 1 call,
 *      2 lượt còn lại 'suppressed'.
 *
 * Mock fetch global để đếm/inspect call. Không gửi Lark thật.
 *
 * Cleanup: xóa toàn bộ dấu vết throwaway kể cả khi test fail.
 * Guard đầu: DB phải có đúng 1 org (Betacom) trước khi seed — cùng pattern
 * verify-n2-cross-tenant.ts.
 */

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// Bật kill switch + set dashboard URL cho session verify (để nửa 1 có button).
process.env.LARK_NOTIFY_ENABLED = "true";
process.env.NEXT_PUBLIC_APP_URL = "https://verify-fake.local";

const { notifyWarehouseIssue } = await import("../src/lib/lark/notify-warehouse-issue.ts");

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !SERVICE) {
  console.error("Missing SUPABASE env vars.");
  process.exit(2);
}

const admin = createClient(SUPA_URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BETACOM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const BETACOM_WEBHOOK = "https://open.larksuite.com/open-apis/bot/v2/hook/betacom-fake";
const THROWAWAY_WEBHOOK = "https://open.larksuite.com/open-apis/bot/v2/hook/throwaway-fake";

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

let failed = 0;
function pass(label: string, detail: string) {
  console.log(`${C.green}✓ PASS${C.reset} ${C.bold}${label}${C.reset} — ${detail}`);
}
function fail(label: string, detail: string) {
  failed++;
  console.log(`${C.red}✗ FAIL${C.reset} ${C.bold}${label}${C.reset} — ${detail}`);
}

// ------------- Guard: DB chỉ có Betacom trước khi seed -------------
{
  const { data: orgs } = await admin.from("organizations").select("id, name");
  if (!orgs || orgs.length !== 1 || orgs[0].id !== BETACOM_ORG_ID) {
    console.error(
      `${C.red}Guard fail: DB có ${orgs?.length ?? 0} org, mong đợi đúng 1 (Betacom). Dừng.${C.reset}`,
    );
    console.error("Orgs:", orgs);
    process.exit(2);
  }
  console.log(`${C.cyan}Guard OK: DB có 1 org Betacom.${C.reset}`);
}

// ------------- Snapshot warehouse Betacom hiện tại (để restore sau) -------------
// Chọn 1 warehouse Betacom sẵn có, config webhook fake trong test, restore cuối.
let betacomWhId: string | null = null;
let betacomWhOriginal: {
  notify_lark_webhook_url: string | null;
  notify_lark_enabled: boolean;
} | null = null;
{
  const { data } = await admin
    .from("warehouses")
    .select("id, notify_lark_webhook_url, notify_lark_enabled")
    .eq("organization_id", BETACOM_ORG_ID)
    .limit(1);
  if (!data || data.length === 0) {
    console.error("Betacom không có warehouse nào — không seed được test.");
    process.exit(2);
  }
  betacomWhId = data[0].id;
  betacomWhOriginal = {
    notify_lark_webhook_url: data[0].notify_lark_webhook_url,
    notify_lark_enabled: data[0].notify_lark_enabled,
  };
  console.log(`${C.cyan}Dùng warehouse Betacom id=${betacomWhId}, sẽ restore config gốc cuối.${C.reset}`);
}

// ------------- Seed org throwaway + warehouse throwaway -------------
const throwawayOrgId = randomUUID();
const throwawayWhId = randomUUID();
{
  const { error: orgErr } = await admin.from("organizations").insert({
    id: throwawayOrgId,
    name: "Lark Verify Throwaway",
    slug: `lark-verify-${throwawayOrgId.slice(0, 8)}`,
  });
  if (orgErr) {
    console.error("Seed org throwaway fail:", orgErr.message);
    process.exit(2);
  }
  const { error: whErr } = await admin.from("warehouses").insert({
    id: throwawayWhId,
    organization_id: throwawayOrgId,
    code: `TW-${throwawayWhId.slice(0, 6).toUpperCase()}`,
    name: "Throwaway Warehouse",
    status: "active",
    notify_lark_webhook_url: THROWAWAY_WEBHOOK,
    notify_lark_enabled: true,
  });
  if (whErr) {
    console.error("Seed warehouse throwaway fail:", whErr.message);
    process.exit(2);
  }
  console.log(`${C.cyan}Seed org+wh throwaway ok.${C.reset}`);
}

// ------------- Mock fetch — bắt mọi call ra Lark webhook -------------
// Mode linh động để nửa 5 (non-2xx) và nửa 6 (timeout) đổi behavior mà không
// phải mock lại global.
type FetchMode = "ok" | "http_500" | "timeout" | "http_200_code_9499" | "http_200_no_code";
let fetchMode: FetchMode = "ok";
const fetchCalls: { url: string; body: string }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = typeof init?.body === "string" ? init.body : "";
  // Chỉ bắt call Lark; nếu code gọi Supabase, forward.
  if (url.includes("larksuite.com") || url.includes("feishu.cn")) {
    fetchCalls.push({ url, body });
    if (fetchMode === "http_500") {
      return new Response("Lark internal error", { status: 500 });
    }
    if (fetchMode === "http_200_code_9499") {
      // Lark trả 200 nhưng body báo lỗi — invalid token. Đây là hố mà
      // BetacomEdu đang bị (không parse body). Đường B logic phán quyết
      // phải bắt: code != 0 → failed.
      return new Response(
        JSON.stringify({ code: 9499, msg: "invalid webhook token" }),
        { status: 200 },
      );
    }
    if (fetchMode === "http_200_no_code") {
      // Response 2xx nhưng body không phải JSON hoặc không có field code.
      // Fallback: dùng HTTP status → sent (giữ hành vi cũ).
      return new Response("OK", { status: 200 });
    }
    if (fetchMode === "timeout") {
      // Giả lập fetch treo: chờ signal.aborted của client (AbortController
      // sẽ kích sau LARK_CONFIG.fetchTimeoutMs = 5s). Khi abort → reject
      // với AbortError, giống fetch thật khi timeout.
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    return new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 });
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof fetch;

function resetFetchLog() {
  fetchCalls.length = 0;
  fetchMode = "ok";
}

async function cleanLogsForWh(whId: string) {
  await admin.from("notification_logs").delete().eq("warehouse_id", whId);
}

// ============================================================================
// Run 4 vế
// ============================================================================

async function runVerification() {
  // ---------- Config Betacom warehouse có webhook để test dương + gộp ----------
  await admin
    .from("warehouses")
    .update({
      notify_lark_webhook_url: BETACOM_WEBHOOK,
      notify_lark_enabled: true,
    })
    .eq("id", betacomWhId!);

  // NỬA 1 — DƯƠNG: ctx Betacom + wh Betacom → 1 call, URL đúng
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    const r = await notifyWarehouseIssue({
      admin,
      organizationId: BETACOM_ORG_ID,
      warehouseId: betacomWhId!,
      eventType: "packing_issue_duplicated",
      waybillCode: "SPX-DUONG-1",
      scannedAtIso: new Date().toISOString(),
    });
    // Parse body để assert card shape (không chỉ "chứa waybill").
    let parsedBody: unknown = null;
    try { parsedBody = JSON.parse(fetchCalls[0]?.body ?? ""); } catch { /* ignore */ }
    const isCard = parsedBody
      && typeof parsedBody === "object"
      && (parsedBody as { msg_type?: string }).msg_type === "interactive"
      && "card" in parsedBody;
    const hasButton = isCard
      && ((parsedBody as { card: { elements: unknown[] } }).card.elements as unknown[])
        .some((el) => {
          const e = el as { tag?: string; actions?: { url?: string }[] };
          return e.tag === "action" && Array.isArray(e.actions)
            && e.actions.some((a) => typeof a.url === "string" && a.url.length > 0);
        });
    const bodyChưaWaybill = fetchCalls[0]?.body.includes("SPX-DUONG-1") ?? false;
    if (r.kind === "sent" && fetchCalls.length === 1 && fetchCalls[0].url === BETACOM_WEBHOOK
        && isCard && hasButton && bodyChưaWaybill) {
      pass(
        "NỬA 1 (dương)",
        `outcome=sent, 1 call URL Betacom, card interactive có button URL, chứa waybill`,
      );
    } else {
      fail(
        "NỬA 1 (dương)",
        `outcome=${r.kind}, calls=${fetchCalls.length}, url=${fetchCalls[0]?.url ?? "n/a"}, isCard=${isCard}, hasButton=${hasButton}, chưaWaybill=${bodyChưaWaybill}`,
      );
    }
  }

  // NỬA 2 — ÂM CROSS-TENANT: ctx org throwaway + wh Betacom → 0 call
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    const r = await notifyWarehouseIssue({
      admin,
      organizationId: throwawayOrgId, // <-- ORG A
      warehouseId: betacomWhId!,       // <-- WH ORG B (Betacom)
      eventType: "packing_issue_duplicated",
      waybillCode: "SPX-LEAK-1",
      scannedAtIso: new Date().toISOString(),
    });
    if (r.kind === "skipped_cross_tenant" && fetchCalls.length === 0) {
      pass(
        "NỬA 2 (âm cross-tenant)",
        `outcome=skipped_cross_tenant, 0 call → org throwaway KHÔNG chạm webhook Betacom`,
      );
    } else if (fetchCalls.length > 0) {
      fail(
        "NỬA 2 (âm cross-tenant)",
        `LEAK NGHIÊM TRỌNG: org throwaway đã gọi ${fetchCalls.length} lần tới ${fetchCalls.map(c => c.url).join(",")}`,
      );
    } else {
      fail(
        "NỬA 2 (âm cross-tenant)",
        `mong skipped_cross_tenant, nhận outcome=${r.kind}, calls=${fetchCalls.length}`,
      );
    }
  }

  // NỬA 3 — ÂM FAIL-SAFE: kho không config webhook → 0 call, không throw
  {
    // Tắt webhook Betacom
    await admin
      .from("warehouses")
      .update({ notify_lark_webhook_url: null, notify_lark_enabled: false })
      .eq("id", betacomWhId!);

    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    let threw = false;
    let outcome: string = "";
    try {
      const r = await notifyWarehouseIssue({
        admin,
        organizationId: BETACOM_ORG_ID,
        warehouseId: betacomWhId!,
        eventType: "packing_issue_no_active_session",
        waybillCode: "SPX-DISABLED-1",
        scannedAtIso: new Date().toISOString(),
      });
      outcome = r.kind;
    } catch {
      threw = true;
    }
    if (!threw && outcome === "disabled" && fetchCalls.length === 0) {
      pass(
        "NỬA 3 (âm fail-safe)",
        `kho không config → outcome=disabled, 0 call, KHÔNG throw (an toàn cho hot path quét)`,
      );
    } else {
      fail(
        "NỬA 3 (âm fail-safe)",
        `mong không throw + outcome=disabled + 0 call; nhận threw=${threw}, outcome=${outcome}, calls=${fetchCalls.length}`,
      );
    }

    // Bật lại webhook để nửa 4 chạy
    await admin
      .from("warehouses")
      .update({
        notify_lark_webhook_url: BETACOM_WEBHOOK,
        notify_lark_enabled: true,
      })
      .eq("id", betacomWhId!);
  }

  // NỬA 4 — ÂM GỘP CỬA SỔ: 3 lỗi cùng (wh, event) trong 1 cửa sổ → CHỈ 1 call
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    const now = new Date().toISOString();

    const r1 = await notifyWarehouseIssue({
      admin,
      organizationId: BETACOM_ORG_ID,
      warehouseId: betacomWhId!,
      eventType: "packing_issue_invalid_code",
      waybillCode: "SPX-GOP-1",
      scannedAtIso: now,
    });
    const r2 = await notifyWarehouseIssue({
      admin,
      organizationId: BETACOM_ORG_ID,
      warehouseId: betacomWhId!,
      eventType: "packing_issue_invalid_code",
      waybillCode: "SPX-GOP-2",
      scannedAtIso: now,
    });
    const r3 = await notifyWarehouseIssue({
      admin,
      organizationId: BETACOM_ORG_ID,
      warehouseId: betacomWhId!,
      eventType: "packing_issue_invalid_code",
      waybillCode: "SPX-GOP-3",
      scannedAtIso: now,
    });

    const kinds = [r1.kind, r2.kind, r3.kind];
    const sentCount = kinds.filter(k => k === "sent").length;
    const suppressedCount = kinds.filter(k => k === "suppressed").length;

    if (sentCount === 1 && suppressedCount === 2 && fetchCalls.length === 1) {
      pass(
        "NỬA 4 (âm gộp cửa sổ)",
        `3 lỗi → outcomes=[${kinds.join(",")}], fetch calls=1 (chống spam ăn thật)`,
      );
    } else {
      fail(
        "NỬA 4 (âm gộp cửa sổ)",
        `mong 1 sent + 2 suppressed + 1 call, nhận outcomes=[${kinds.join(",")}], calls=${fetchCalls.length}`,
      );
    }
  }

  // NỬA 5 — FAILED HTTP: fetch trả 500 → row status='failed', error_message
  // có nội dung, KHÔNG throw ra ngoài. Đây là CÔNG CỤ ĐO cho vế 3+4 verify
  // production — nếu nhánh này sai, row Lark-lỗi sẽ kẹt 'pending' và ta
  // chẩn đoán nhầm "after() không cứu".
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    fetchMode = "http_500";
    let threw = false;
    let outcome = "";
    try {
      const r = await notifyWarehouseIssue({
        admin,
        organizationId: BETACOM_ORG_ID,
        warehouseId: betacomWhId!,
        eventType: "packing_issue_duplicated",
        waybillCode: "SPX-FAIL-500",
        scannedAtIso: new Date().toISOString(),
      });
      outcome = r.kind;
    } catch {
      threw = true;
    }
    // Đọc DB: row phải là 'failed' (không kẹt 'pending'), error_message có nội dung,
    // response_status=500 (bằng chứng debug ghi đúng).
    const { data: rows } = await admin
      .from("notification_logs")
      .select("status, error_message, response_status, response_body")
      .eq("warehouse_id", betacomWhId!)
      .eq("event_type", "packing_issue_duplicated")
      .in("status", ["pending", "sent", "failed"]);
    const row = rows?.[0] as { status: string; error_message: string | null; response_status: number | null; response_body: string | null } | undefined;
    const okStatus = row?.status === "failed";
    const okError = typeof row?.error_message === "string" && row.error_message.length > 0;
    const okRespStatus = row?.response_status === 500;
    const okRespBody = typeof row?.response_body === "string" && row.response_body.includes("Lark internal error");
    if (!threw && outcome === "failed" && okStatus && okError && okRespStatus && okRespBody) {
      pass(
        "NỬA 5 (failed HTTP 500)",
        `outcome=failed, status='failed', error_message OK, response_status=500, response_body log đúng, KHÔNG throw`,
      );
    } else {
      fail(
        "NỬA 5 (failed HTTP 500)",
        `threw=${threw}, outcome=${outcome}, row=${JSON.stringify(row)}, okStatus=${okStatus}, okError=${okError}, okRespStatus=${okRespStatus}, okRespBody=${okRespBody}`,
      );
    }
  }

  // NỬA 6 — FAILED TIMEOUT: fetch treo, AbortController kích sau 5s →
  // row 'failed' + error_message nói timeout/abort. Timeout là ca hay gặp
  // nhất thực tế (Lark chậm/mạng lag), khác non-2xx.
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    fetchMode = "timeout";
    const start = Date.now();
    let threw = false;
    let outcome = "";
    try {
      const r = await notifyWarehouseIssue({
        admin,
        organizationId: BETACOM_ORG_ID,
        warehouseId: betacomWhId!,
        eventType: "packing_issue_unmapped_scanner",
        waybillCode: "SPX-TIMEOUT",
        scannedAtIso: new Date().toISOString(),
      });
      outcome = r.kind;
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - start;
    const { data: rows } = await admin
      .from("notification_logs")
      .select("status, error_message, response_status")
      .eq("warehouse_id", betacomWhId!)
      .eq("event_type", "packing_issue_unmapped_scanner")
      .in("status", ["pending", "sent", "failed"]);
    const row = rows?.[0] as { status: string; error_message: string | null; response_status: number | null } | undefined;
    const okStatus = row?.status === "failed";
    const okError = typeof row?.error_message === "string" && row.error_message.length > 0;
    // Network fail trước khi có response → response_status phải null.
    const okRespStatus = row?.response_status === null;
    // AbortController kích ~5000ms; cho phép 4500-8000ms.
    const okTiming = elapsed >= 4500 && elapsed <= 8000;
    if (!threw && outcome === "failed" && okStatus && okError && okTiming && okRespStatus) {
      pass(
        "NỬA 6 (failed timeout)",
        `outcome=failed sau ${elapsed}ms, status='failed', response_status=null (network fail), error_message OK, KHÔNG throw`,
      );
    } else {
      fail(
        "NỬA 6 (failed timeout)",
        `threw=${threw}, outcome=${outcome}, elapsed=${elapsed}ms, row=${JSON.stringify(row)}, okStatus=${okStatus}, okError=${okError}, okTiming=${okTiming}, okRespStatus=${okRespStatus}`,
      );
    }
  }

  // NỬA 7 — HTTP 200 + BODY CODE != 0: bằng chứng lớn — BetacomEdu bị hố này
  // 3-4 tháng. Fetch trả 200 (HTTP OK) nhưng body báo lỗi
  // {"code":9499,"msg":"invalid webhook token"}. Đường B: `code !== 0` →
  // `failed`, error_message = "lark_code_9499: ..." (không phải sent giả).
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    fetchMode = "http_200_code_9499";
    let threw = false;
    let outcome = "";
    try {
      const r = await notifyWarehouseIssue({
        admin,
        organizationId: BETACOM_ORG_ID,
        warehouseId: betacomWhId!,
        eventType: "packing_issue_no_active_session",
        waybillCode: "SPX-CODE-9499",
        scannedAtIso: new Date().toISOString(),
      });
      outcome = r.kind;
    } catch {
      threw = true;
    }
    const { data: rows } = await admin
      .from("notification_logs")
      .select("status, error_message, response_status, response_body")
      .eq("warehouse_id", betacomWhId!)
      .eq("event_type", "packing_issue_no_active_session")
      .in("status", ["pending", "sent", "failed"]);
    const row = rows?.[0] as { status: string; error_message: string | null; response_status: number | null; response_body: string | null } | undefined;
    const okStatus = row?.status === "failed";
    const okError = typeof row?.error_message === "string" && row.error_message.includes("lark_code_9499");
    const okRespStatus = row?.response_status === 200; // HTTP thực sự là 200
    const okRespBody = typeof row?.response_body === "string" && row.response_body.includes("9499");
    if (!threw && outcome === "failed" && okStatus && okError && okRespStatus && okRespBody) {
      pass(
        "NỬA 7 (HTTP 200 + code 9499)",
        `outcome=failed (KHÔNG bị lừa bởi HTTP 200), status='failed', error='${row?.error_message?.slice(0, 50)}...', response_status=200 lưu đúng, body chứa 9499`,
      );
    } else {
      fail(
        "NỬA 7 (HTTP 200 + code 9499)",
        `threw=${threw}, outcome=${outcome}, row=${JSON.stringify(row)}, okStatus=${okStatus}, okError=${okError}, okRespStatus=${okRespStatus}, okRespBody=${okRespBody}`,
      );
    }
  }

  // NỬA 8 — HTTP 200 + BODY KHÔNG CÓ CODE FIELD: fallback HTTP status.
  // Đường B chấp nhận (không tệ hơn hành vi cũ). Assert: sent + response_body log.
  {
    resetFetchLog();
    await cleanLogsForWh(betacomWhId!);
    fetchMode = "http_200_no_code";
    let threw = false;
    let outcome = "";
    try {
      const r = await notifyWarehouseIssue({
        admin,
        organizationId: BETACOM_ORG_ID,
        warehouseId: betacomWhId!,
        eventType: "packing_issue_invalid_code",
        waybillCode: "SPX-NO-CODE",
        scannedAtIso: new Date().toISOString(),
      });
      outcome = r.kind;
    } catch {
      threw = true;
    }
    const { data: rows } = await admin
      .from("notification_logs")
      .select("status, response_status, response_body")
      .eq("warehouse_id", betacomWhId!)
      .eq("event_type", "packing_issue_invalid_code")
      .in("status", ["pending", "sent", "failed"]);
    const row = rows?.[0] as { status: string; response_status: number | null; response_body: string | null } | undefined;
    const okStatus = row?.status === "sent";
    const okRespStatus = row?.response_status === 200;
    const okRespBody = row?.response_body === "OK";
    if (!threw && outcome === "sent" && okStatus && okRespStatus && okRespBody) {
      pass(
        "NỬA 8 (HTTP 200 no code — fallback)",
        `outcome=sent (fallback HTTP status khi body không JSON/không có code), response_body='OK' lưu đúng`,
      );
    } else {
      fail(
        "NỬA 8 (HTTP 200 no code — fallback)",
        `threw=${threw}, outcome=${outcome}, row=${JSON.stringify(row)}, okStatus=${okStatus}, okRespStatus=${okRespStatus}, okRespBody=${okRespBody}`,
      );
    }
  }
}

let runErr: unknown = null;
try {
  await runVerification();
} catch (e) {
  runErr = e;
  console.error(`${C.red}Run threw:${C.reset}`, e);
}

// ============================================================================
// Cleanup — ALWAYS chạy
// ============================================================================
console.log(`\n${C.cyan}Cleanup…${C.reset}`);
globalThis.fetch = originalFetch;

// Restore warehouse Betacom về config gốc
if (betacomWhId && betacomWhOriginal) {
  const { error } = await admin
    .from("warehouses")
    .update({
      notify_lark_webhook_url: betacomWhOriginal.notify_lark_webhook_url,
      notify_lark_enabled: betacomWhOriginal.notify_lark_enabled,
    })
    .eq("id", betacomWhId);
  if (error) console.error(`Restore warehouse Betacom fail: ${error.message}`);
  else console.log(`  Restore warehouse Betacom về config gốc — OK`);
}

// Xóa notification_logs của warehouse Betacom (test đã bơm rác)
if (betacomWhId) {
  await admin.from("notification_logs").delete().eq("warehouse_id", betacomWhId);
  console.log(`  Xóa notification_logs của warehouse Betacom — OK`);
}

// Xóa warehouse throwaway (notification_logs ON DELETE CASCADE dọn theo)
{
  const { error } = await admin.from("warehouses").delete().eq("id", throwawayWhId);
  if (error) console.error(`Cleanup warehouse throwaway fail: ${error.message}`);
  else console.log(`  Xóa warehouse throwaway — OK`);
}
{
  const { error } = await admin.from("organizations").delete().eq("id", throwawayOrgId);
  if (error) console.error(`Cleanup org throwaway fail: ${error.message}`);
  else console.log(`  Xóa org throwaway — OK`);
}

// Verify cleanup sạch
{
  const { data } = await admin.from("organizations").select("id");
  if (!data || data.length !== 1 || data[0].id !== BETACOM_ORG_ID) {
    console.error(
      `${C.red}Cleanup KHÔNG SẠCH: còn ${data?.length ?? 0} org sau cleanup.${C.reset}`,
      data,
    );
    process.exit(3);
  }
  console.log(`${C.cyan}Cleanup OK: DB về 1 org Betacom.${C.reset}`);
}

if (runErr) {
  console.error(`${C.red}Verify aborted do exception.${C.reset}`);
  process.exit(2);
}

if (failed > 0) {
  console.log(`\n${C.red}${C.bold}LARK VERIFY FAIL: ${failed}/8 nửa fail.${C.reset}`);
  process.exit(1);
}
console.log(`\n${C.green}${C.bold}LARK verify: 8/8 nửa PASS.${C.reset}`);
