import { NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission, isError } from "@/lib/supabase/guard";
import { normalizeWaybillCode } from "@/lib/warehouse/normalize-code";
import { looksLikeControlCard, parseControlCard } from "@/lib/station/control-cards";
import {
  closeOpenReturnWithResult,
  currentStationMode,
  processReturnScan,
} from "@/lib/station/return-scan";
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

  // Manual/HID input belongs to the scanner source. Refuse before writing a
  // raw event when the station is configured for camera QR; unlike agent
  // ingest, this browser endpoint is synchronous and can give immediate UI
  // feedback without representing a physical scan attempt.
  const { data: resolved } = await admin
    .rpc("resolve_scanner_at", {
      p_organization_id: ctx.organizationId,
      p_device_code: scannerCode,
      p_at: scannedAt,
    })
    .maybeSingle<{ station_id: string }>();
  if (resolved?.station_id) {
    const { data: station } = await admin
      .from("packing_stations")
      .select("scan_source")
      .eq("organization_id", ctx.organizationId)
      .eq("id", resolved.station_id)
      .maybeSingle();
    if (station?.scan_source === "camera") {
      return NextResponse.json(
        {
          error: "scan_source_disabled",
          message: "Bàn này đang dùng camera để đọc mã.",
        },
        { status: 409 },
      );
    }
  }

  // Thẻ điều khiển gõ tay: dùng khi bàn chưa có súng quét, hoặc khi thử
  // luồng mà không cần phần cứng. Đi đúng đường của thẻ quét bằng súng.
  const controlCard = looksLikeControlCard(rawValue) ? parseControlCard(rawValue) : null;
  if (looksLikeControlCard(rawValue)) {
    if (!resolved?.station_id) {
      return NextResponse.json(
        { error: "unmapped_scanner", message: "Máy quét chưa gắn vào bàn nào." },
        { status: 409 },
      );
    }
    if (!controlCard) {
      return NextResponse.json(
        { error: "invalid_control_card", message: "Thẻ điều khiển không đọc được." },
        { status: 400 },
      );
    }
    if (controlCard.kind !== "mode") {
      // Thẻ kết quả / thẻ KẾT THÚC: đóng kiện hoàn đang mở của bàn.
      const outcome = await closeOpenReturnWithResult({
        admin,
        organizationId: ctx.organizationId,
        stationId: resolved.station_id,
        result: controlCard.kind === "result" ? controlCard.result : "unchecked",
        closeReason: controlCard.kind === "result" ? "result_card" : "end_card",
        at: scannedAt,
      });
      if (!outcome.closed) {
        return NextResponse.json(
          { error: "no_open_return", message: "Chưa có kiện hoàn nào đang mở." },
          { status: 409 },
        );
      }
      return NextResponse.json({
        ok: true,
        control_action: {
          action: "return_closed",
          waybill_code: outcome.waybill_code,
          result: outcome.result,
        },
      });
    }
    const { error: modeErr } = await admin.rpc("set_station_mode", {
      p_station_id: resolved.station_id,
      p_mode: controlCard.mode,
      p_started_by: "card",
      p_reason: `card_${controlCard.mode}`,
      p_at: scannedAt,
    });
    if (modeErr) {
      return NextResponse.json(
        { error: "set_mode_failed", message: modeErr.message },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      control_action: {
        action: "mode_changed",
        mode: controlCard.mode,
        message:
          controlCard.mode === "return"
            ? "Bàn chuyển sang chế độ nhận hàng hoàn."
            : "Bàn quay lại chế độ đóng hàng.",
      },
    });
  }

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

  // Bàn đang NHẬN HOÀN: mã vận đơn là kiện hàng hoàn.
  const stationMode = resolved?.station_id
    ? await currentStationMode(admin, resolved.station_id)
    : "outbound";

  if (stationMode === "return") {
    const returnResult = await processReturnScan(admin, eventId);
    return NextResponse.json({
      ok: true,
      duplicate: isDuplicate,
      event_id: eventId,
      scan_type: "waybill",
      station_mode: stationMode,
      return_result: returnResult,
      warning: null,
    });
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
    station_mode: stationMode,
    packing_result: pack ?? null,
    warning,
  });
}
