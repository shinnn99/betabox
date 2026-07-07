import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentRequest,
} from "@/lib/warehouse/agent-auth";
import { AGENT_API_PATHS } from "@/lib/warehouse/agent-api-paths";
import { recordAgentSigVersion } from "@/lib/warehouse/agent-sig-telemetry";
import {
  recognizeStaffQr,
  tryParseStaffQr,
  type RecognizedStaff,
} from "@/lib/warehouse/staff-qr";
import { normalizeWaybillCode } from "@/lib/warehouse/normalize-code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ScanSource = "serial" | "hid_keyboard" | "manual";

interface ScanPayload {
  agent_event_id: string;
  scanner_device_code: string;
  port?: string | null;
  raw_value: string;
  scanned_at: string;
  source: ScanSource;
  device_identity_snapshot: Record<string, unknown> | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(error: string, message?: string) {
  return NextResponse.json({ error, message }, { status: 400 });
}

function parsePayload(raw: unknown): ScanPayload | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const agentEventId = typeof r.agent_event_id === "string" ? r.agent_event_id.trim() : "";
  if (!agentEventId) return { error: "agent_event_id_required" };
  if (!UUID_RE.test(agentEventId)) return { error: "agent_event_id_invalid" };

  const scanner = typeof r.scanner_device_code === "string" ? r.scanner_device_code.trim() : "";
  if (!scanner) return { error: "scanner_device_code_required" };

  const rawValueIn = typeof r.raw_value === "string" ? r.raw_value.trim() : "";
  if (!rawValueIn) return { error: "raw_value_required" };

  const scannedAtRaw = typeof r.scanned_at === "string" ? r.scanned_at.trim() : "";
  if (!scannedAtRaw) return { error: "scanned_at_required" };
  const t = Date.parse(scannedAtRaw);
  if (!Number.isFinite(t)) return { error: "scanned_at_invalid" };

  const port = typeof r.port === "string" && r.port.trim() ? r.port.trim() : null;

  // Backward compatible: older agents omit `source` — default to 'serial'
  // (because that's the only thing the legacy agent could be).
  const rawSource = typeof r.source === "string" ? r.source.trim() : "serial";
  const source: ScanSource =
    rawSource === "hid_keyboard" || rawSource === "manual"
      ? rawSource
      : "serial";

  const identity =
    r.device_identity_snapshot && typeof r.device_identity_snapshot === "object"
      ? (r.device_identity_snapshot as Record<string, unknown>)
      : null;

  return {
    agent_event_id: agentEventId,
    scanner_device_code: scanner,
    raw_value: rawValueIn,
    scanned_at: new Date(t).toISOString(),
    port,
    source,
    device_identity_snapshot: identity,
  };
}

type ScanType = "staff_qr" | "waybill";

/**
 * Staff QR thật có dạng `<org_uuid>.<staff_uuid>.<rawToken>`.
 * Bất cứ chuỗi nào khớp regex đó được coi là staff_qr; còn lại là waybill.
 * Recognition (verify token_hash) chạy ở bước sau, không ảnh hưởng phân loại.
 */
function detectScanType(rawValue: string): ScanType {
  return tryParseStaffQr(rawValue) ? "staff_qr" : "waybill";
}

interface SessionAction {
  action: "checked_in" | "checked_out" | "switched_station" | "replaced_staff" | "ignored";
  session_id: string | null;
  station_id: string | null;
  warehouse_id: string | null;
  ended_session_ids: string[];
  warning_code: string | null;
  message: string | null;
}

interface PackingResult {
  status: "valid" | "duplicated" | "no_active_session" | "unmapped_scanner" | "invalid_code";
  packing_event_id: string | null;
  order_id: string | null;
  waybill_code: string | null;
  station_id: string | null;
  warehouse_id: string | null;
  staff_id: string | null;
  work_session_id: string | null;
  assignment_method: "active_session" | "fallback_recent_session" | "none";
  previous_event_id: string | null;
}

interface PackingRpcRow {
  status: PackingResult["status"];
  packing_event_id: string | null;
  order_id: string | null;
  waybill_code: string | null;
  station_id: string | null;
  warehouse_id: string | null;
  staff_id: string | null;
  work_session_id: string | null;
  assignment_method: PackingResult["assignment_method"];
  previous_event_id: string | null;
}

interface SessionRpcRow {
  action: SessionAction["action"];
  started_session_id: string | null;
  ended_session_ids: string[] | null;
  warning_code: string | null;
  message: string | null;
}

/**
 * Phase 5: turn a waybill raw scan into a packing_event. Idempotent per
 * raw_event_id; retries return the same packing_event_id.
 */
async function runWaybillRpc(
  admin: ReturnType<typeof createAdminClient>,
  rawEventId: string,
): Promise<PackingResult | null> {
  const { data, error } = await admin
    .rpc("process_waybill_scan", { p_raw_event_id: rawEventId })
    .single<PackingRpcRow>();
  if (error || !data) {
    console.error(`[warehouse-scans] waybill RPC failed: ${error?.message}`);
    return null;
  }
  return data;
}

/**
 * Calls the transactional state-machine RPC. The RPC is idempotent per
 * raw_event_id, so re-invoking it during agent retries returns the same
 * result without toggling state.
 */
async function runSessionRpc(
  admin: ReturnType<typeof createAdminClient>,
  args: {
    orgId: string;
    rawEventId: string;
    staffId: string;
    stationId: string;
    warehouseId: string;
    occurredAt: string;
  },
): Promise<SessionAction | null> {
  const { data, error } = await admin
    .rpc("process_staff_qr_session", {
      p_organization_id: args.orgId,
      p_raw_event_id: args.rawEventId,
      p_staff_id: args.staffId,
      p_station_id: args.stationId,
      p_warehouse_id: args.warehouseId,
      p_occurred_at: args.occurredAt,
    })
    .single<SessionRpcRow>();
  if (error || !data) {
    console.error(`[warehouse-scans] session RPC failed: ${error?.message}`);
    return null;
  }
  return {
    action: data.action,
    session_id: data.started_session_id,
    station_id: args.stationId,
    warehouse_id: args.warehouseId,
    ended_session_ids: data.ended_session_ids ?? [],
    warning_code: data.warning_code,
    message: data.message,
  };
}

export async function POST(req: Request) {
  const headers = readAgentHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "missing_headers" }, { status: 400 });
  }

  const rawBody = await req.text();

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return badRequest("invalid_json");
  }

  const parsed = parsePayload(json);
  if ("error" in parsed) return badRequest(parsed.error);

  const admin = createAdminClient();

  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret, hmac_v2_enforced_at")
    .eq("code", headers.code)
    .maybeSingle();

  if (agentErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!agent) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 401 });
  }
  if (agent.status !== "active") {
    return NextResponse.json({ error: "agent_disabled" }, { status: 403 });
  }

  const verdict = await verifyAgentRequest(admin, {
    rawBody,
    method: "POST",
    canonicalPath: AGENT_API_PATHS.scans,
    headers,
    agentId: agent.id,
    hmacV2EnforcedAt: agent.hmac_v2_enforced_at,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  recordAgentSigVersion(agent.id, verdict.version);

  const scanType = detectScanType(parsed.raw_value);

  // Pre-compute the cleaned-up code for waybill scans so we can store it
  // alongside the raw. Staff QR carries its own structure; never rewrite it.
  const normalized =
    scanType === "waybill" ? normalizeWaybillCode(parsed.raw_value) : null;

  // Phase 2 advisory check: resolve scanner -> station at scanned_at.
  // We never block ingestion on this and never write the resolved station
  // into the raw row — raw events stay immutable and mapping is queried at
  // read-time. The result is returned to the agent so it can surface a
  // visible warning when the scanner isn't (yet) mapped to a station.
  const { data: resolved } = await admin
    .rpc("resolve_scanner_at", {
      p_organization_id: agent.organization_id,
      p_device_code: parsed.scanner_device_code,
      p_at: parsed.scanned_at,
    })
    .maybeSingle<{
      device_id: string;
      station_id: string;
      warehouse_id: string;
      assigned_at: string;
      unassigned_at: string | null;
    }>();

  const scannerUnmapped = !resolved;
  if (scannerUnmapped) {
    console.warn(
      `[warehouse-scans] unmapped scanner: org=${agent.organization_id} device=${parsed.scanner_device_code} at=${parsed.scanned_at}`,
    );
  }

  // Phase 3 recognition: if the QR shape matches a staff token, verify it
  // against staff_qr_credentials. Never blocks ingestion — invalid QR just
  // gets a warning and the raw event is still recorded.
  let recognizedStaff: RecognizedStaff | null = null;
  let staffQrInvalidReason: string | null = null;
  if (scanType === "staff_qr") {
    const parsedQr = tryParseStaffQr(parsed.raw_value);
    if (parsedQr) {
      const outcome = await recognizeStaffQr(admin, agent.organization_id, parsedQr);
      if (outcome.kind === "recognized") {
        recognizedStaff = outcome.staff;
      } else {
        staffQrInvalidReason = outcome.reason;
        console.warn(
          `[warehouse-scans] invalid staff QR: org=${agent.organization_id} reason=${outcome.reason}`,
        );
      }
    }
  }

  // Warning priority: for staff_qr scans, an invalid QR is the relevant
  // signal. For waybill scans, an unmapped scanner is. We only expose one
  // warning field so the agent log stays terse.
  const warning: { code: string; message: string } | null =
    scanType === "staff_qr" && staffQrInvalidReason
      ? {
          code: "invalid_staff_qr",
          message: "Staff QR is invalid or revoked",
        }
      : scannerUnmapped
        ? {
            code: "unmapped_scanner",
            message: `Scanner ${parsed.scanner_device_code} chưa được gán vào bàn nào tại thời điểm quét.`,
          }
        : normalized?.warning === "suspicious_encoding"
          ? {
              code: "suspicious_encoding",
              message:
                "Mã quét có ký tự lạ. Kiểm tra cấu hình bàn phím hoặc scanner (layout/encoding).",
            }
          : null;

  let eventId: string;
  let isDuplicate: boolean;
  {
    const { data: inserted, error: insertErr } = await admin
      .from("warehouse_scan_raw_events")
      .insert({
        organization_id: agent.organization_id,
        agent_id: agent.id,
        agent_event_id: parsed.agent_event_id,
        scanner_device_code: parsed.scanner_device_code,
        port: parsed.port,
        raw_value: parsed.raw_value,
        normalized_value: normalized?.normalized ?? null,
        scan_type: scanType,
        scanned_at: parsed.scanned_at,
        source: parsed.source,
        device_identity_snapshot: parsed.device_identity_snapshot,
      })
      .select("id, scan_type")
      .single();

    if (insertErr) {
      // 23505 = unique_violation. The agent retried after we already wrote
      // the row — fetch existing event id and let processing continue.
      if ((insertErr as { code?: string }).code === "23505") {
        const { data: existing } = await admin
          .from("warehouse_scan_raw_events")
          .select("id, scan_type")
          .eq("agent_id", agent.id)
          .eq("agent_event_id", parsed.agent_event_id)
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
      isDuplicate = false;
    }
  }

  // Phase 4: drive the work-session state machine. Conditions to run:
  //   * Scan parsed as a staff QR and recognized against a credential.
  //   * Scanner mapped to a station at scanned_at.
  // The RPC itself is idempotent per raw_event_id, so retries are safe.
  let sessionAction: SessionAction | null = null;
  if (
    scanType === "staff_qr" &&
    recognizedStaff &&
    resolved &&
    resolved.station_id &&
    resolved.warehouse_id
  ) {
    sessionAction = await runSessionRpc(admin, {
      orgId: agent.organization_id,
      rawEventId: eventId,
      staffId: recognizedStaff.staff_id,
      stationId: resolved.station_id,
      warehouseId: resolved.warehouse_id,
      occurredAt: parsed.scanned_at,
    });
  }

  // Phase 5: drive the waybill → packing_event pipeline. Run for every
  // waybill scan — the RPC itself records unmapped/no-session/duplicate
  // statuses so nothing gets dropped.
  let packingResult: PackingResult | null = null;
  if (scanType === "waybill") {
    packingResult = await runWaybillRpc(admin, eventId);
  }

  // Touch last_seen_at. Don't fail the request if it errors.
  const nowIso = new Date().toISOString();
  const { error: seenErr } = await admin
    .from("warehouse_agents")
    .update({ last_seen_at: nowIso })
    .eq("id", agent.id);
  if (seenErr) {
    console.warn(
      `[scans] last_seen_at update failed agent=${agent.id} code=${seenErr.code ?? "?"} message=${seenErr.message}`,
    );
  }

  // Opportunistic device-runtime update: when a serial scan carries identity,
  // remember which port the scanner is on right now and mark it connected.
  // We don't overwrite a populated device_identity here — pairing decisions
  // belong to the dedicated assignment endpoint. Just keep runtime fresh.
  if (parsed.source === "serial") {
    const { error: devErr } = await admin
      .from("station_devices")
      .update({
        current_port: parsed.port,
        connection_status: "connected",
        last_seen_at: nowIso,
        bound_agent_id: agent.id,
      })
      .eq("organization_id", agent.organization_id)
      .eq("device_code", parsed.scanner_device_code)
      .eq("device_type", "scanner");
    if (devErr) {
      console.error(
        `[scans] scanner runtime update failed agent=${agent.id} device_code=${parsed.scanner_device_code} code=${devErr.code ?? "?"} message=${devErr.message}`,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    duplicate: isDuplicate,
    event_id: eventId,
    scan_type: scanType,
    recognized_staff: recognizedStaff,
    session_action: sessionAction,
    packing_result: packingResult,
    warning,
  });
}
