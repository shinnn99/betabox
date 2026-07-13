import { NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { normalizeWaybillCode } from "@/lib/warehouse/normalize-code";
import { hookLarkNotifyScan } from "@/lib/lark/hook-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HID / manual scan ingestion.
 *
 * Used by the in-browser fallback page when a scanner is attached as a
 * USB HID keyboard, or when an operator types a waybill code by hand.
 * Authentication is the dashboard user session (not the agent HMAC),
 * scoped by the user's organization_id.
 *
 * The row is written with agent_id = NULL so it's distinguishable from
 * scans coming through the local agent. Idempotency uses the partial
 * unique index uniq_manual_scan_event (organization_id, agent_event_id).
 *
 * Waybill scans still go through process_waybill_scan — the RPC owns the
 * business rules and we want HID scans to behave identically to serial.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PackingRpcRow {
  status: string;
  packing_event_id: string | null;
  order_id: string | null;
  waybill_code: string | null;
  station_id: string | null;
  warehouse_id: string | null;
  staff_id: string | null;
  work_session_id: string | null;
  assignment_method: string;
  previous_event_id: string | null;
}

export async function POST(req: Request) {
  const ctx = await requirePermission("station_device.view");
  if (isError(ctx)) return ctx;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const rec = body as Record<string, unknown>;

  const agentEventId =
    typeof rec.agent_event_id === "string" ? rec.agent_event_id.trim() : "";
  if (!agentEventId || !UUID_RE.test(agentEventId)) {
    return NextResponse.json(
      { error: "agent_event_id_invalid" },
      { status: 400 },
    );
  }

  // The browser sends `scanner_device_code` — typically a virtual code the
  // station picks ("HID_BAN_01"). We don't require it to be paired in
  // station_devices; resolve_scanner_at returns no-row → warning surfaces.
  const scannerCode =
    typeof rec.scanner_device_code === "string"
      ? rec.scanner_device_code.trim().toUpperCase()
      : "";
  if (!scannerCode) {
    return NextResponse.json(
      { error: "scanner_device_code_required" },
      { status: 400 },
    );
  }

  const rawValue = typeof rec.raw_value === "string" ? rec.raw_value : "";
  if (!rawValue.trim()) {
    return NextResponse.json({ error: "raw_value_required" }, { status: 400 });
  }

  const scannedAtRaw =
    typeof rec.scanned_at === "string" ? rec.scanned_at.trim() : "";
  const t = scannedAtRaw ? Date.parse(scannedAtRaw) : Date.now();
  if (!Number.isFinite(t)) {
    return NextResponse.json({ error: "scanned_at_invalid" }, { status: 400 });
  }
  const scannedAt = new Date(t).toISOString();

  const source: "hid_keyboard" | "manual" =
    rec.source === "manual" ? "manual" : "hid_keyboard";

  // For HID we currently only handle waybill scans. Staff QR via HID is
  // possible but rare; the dashboard staff page uses a different flow.
  const normalized = normalizeWaybillCode(rawValue);

  const admin = createAdminClient();

  let eventId: string;
  let isDuplicate = false;

  const { data: inserted, error: insertErr } = await admin
    .from("warehouse_scan_raw_events")
    .insert({
      organization_id: ctx.organizationId,
      agent_id: null,
      agent_event_id: agentEventId,
      scanner_device_code: scannerCode,
      port: null,
      raw_value: rawValue,
      normalized_value: normalized.normalized,
      scan_type: "waybill",
      scanned_at: scannedAt,
      source,
      device_identity_snapshot: null,
    })
    .select("id")
    .single();

  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      const { data: existing } = await admin
        .from("warehouse_scan_raw_events")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("agent_event_id", agentEventId)
        .is("agent_id", null)
        .single();
      if (!existing) {
        return NextResponse.json(
          { error: "insert_failed", message: insertErr.message },
          { status: 500 },
        );
      }
      eventId = existing.id;
      isDuplicate = true;
    } else {
      return NextResponse.json(
        { error: "insert_failed", message: insertErr.message },
        { status: 500 },
      );
    }
  } else {
    eventId = inserted.id;
  }

  const { data: pack } = await admin
    .rpc("process_waybill_scan", { p_raw_event_id: eventId })
    .single<PackingRpcRow>();

  // Lark notify — schedule sau response bằng `after()` (Next.js 15+).
  // Vercel serverless: fire-and-forget "trần" bị kill khi lambda freeze sau
  // response → notify mất phi định. `after` gắn Promise vào `waitUntil`,
  // extend lifetime tới khi settled.
  const packForNotify = pack;
  const scannedAtForNotify = scannedAt;
  const orgIdForNotify = ctx.organizationId;
  after(() => {
    hookLarkNotifyScan({
      admin,
      organizationId: orgIdForNotify,
      packingResult: packForNotify,
      scannedAtIso: scannedAtForNotify,
    });
  });

  const warning =
    pack?.status === "unmapped_scanner"
      ? {
          code: "unmapped_scanner",
          message: `Mã thiết bị "${scannerCode}" chưa gán vào bàn nào — tạo station_device và gán bàn trước.`,
        }
      : normalized.warning === "suspicious_encoding"
        ? {
            code: "suspicious_encoding",
            message:
              "Mã quét có ký tự lạ. Kiểm tra layout bàn phím hoặc cấu hình scanner.",
          }
        : null;

  return NextResponse.json({
    ok: true,
    duplicate: isDuplicate,
    event_id: eventId,
    scan_type: "waybill",
    packing_result: pack ?? null,
    warning,
  });
}
