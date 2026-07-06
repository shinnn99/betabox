import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readAgentHeaders,
  verifyAgentSignature,
} from "@/lib/warehouse/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent → backend discovery snapshot.
 *
 * The local agent posts what serial ports it currently sees plus the
 * raw USB identity for each. We cache the snapshot on warehouse_agents so
 * the pairing UI ("Tìm máy quét") can read it without round-tripping the
 * agent in real-time.
 *
 * For each reported port we also try to resolve it to an existing
 * station_device via resolve_scanner_by_identity. The response gives the
 * agent back the device_code it should use for subsequent scans — that's
 * how the agent stays correct after a COM port reshuffle.
 *
 * Body:
 *   { ports: [{
 *       path: "COM7",
 *       manufacturer?, product_id?, vendor_id?, serial_number?, pnp_id?
 *     }, ...] }
 *
 * Response:
 *   { ports: [{
 *       path, identity, match: { device_id, device_code, match_kind } | null
 *     }, ...] }
 */

interface PortInput {
  path: string;
  vendor_id?: string | null;
  product_id?: string | null;
  serial_number?: string | null;
  pnp_id?: string | null;
  manufacturer?: string | null;
  product?: string | null;
  friendly_name?: string | null;
}

interface Identity {
  vid?: string;
  pid?: string;
  serial_number?: string;
  pnp_id?: string;
  manufacturer?: string;
  product?: string;
  friendly_name?: string;
}

function toIdentity(p: PortInput): Identity {
  const id: Identity = {};
  if (p.vendor_id) id.vid = String(p.vendor_id).toLowerCase();
  if (p.product_id) id.pid = String(p.product_id).toLowerCase();
  if (p.serial_number) id.serial_number = String(p.serial_number);
  if (p.pnp_id) id.pnp_id = String(p.pnp_id);
  if (p.manufacturer) id.manufacturer = String(p.manufacturer);
  if (p.product) id.product = String(p.product);
  if (p.friendly_name) id.friendly_name = String(p.friendly_name);
  return id;
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
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const portsIn =
    json && typeof json === "object" && Array.isArray((json as { ports?: unknown[] }).ports)
      ? ((json as { ports: PortInput[] }).ports as PortInput[])
      : [];

  const admin = createAdminClient();
  const { data: agent, error: agentErr } = await admin
    .from("warehouse_agents")
    .select("id, organization_id, status, secret")
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

  const verdict = verifyAgentSignature({
    rawBody,
    headers,
    secret: agent.secret as string,
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  // Resolve each port → station_device via the identity RPC. We do it
  // sequentially because the list is tiny (typically 1-5 ports) and that
  // keeps error handling simple.
  const results: Array<{
    path: string;
    identity: Identity;
    match: { device_id: string; device_code: string; match_kind: string } | null;
  }> = [];

  for (const p of portsIn) {
    if (!p?.path || typeof p.path !== "string") continue;
    const identity = toIdentity(p);
    let match: { device_id: string; device_code: string; match_kind: string } | null = null;
    if (Object.keys(identity).length > 0) {
      const { data } = await admin
        .rpc("resolve_scanner_by_identity", {
          p_organization_id: agent.organization_id,
          p_identity: identity,
        })
        .maybeSingle<{ device_id: string; device_code: string; match_kind: string }>();
      if (data) match = data;
    }
    results.push({ path: p.path, identity, match });

    // Keep runtime state fresh for the matched device. current_port may
    // have changed since boot — that's exactly why we're doing this.
    if (match) {
      const { error: devErr } = await admin
        .from("station_devices")
        .update({
          current_port: p.path,
          connection_status: "connected",
          last_seen_at: new Date().toISOString(),
          bound_agent_id: agent.id,
        })
        .eq("id", match.device_id)
        .eq("organization_id", agent.organization_id);
      if (devErr) {
        console.error(
          `[discovery] device match update failed agent=${agent.id} device=${match.device_id} code=${devErr.code ?? "?"} message=${devErr.message}`,
        );
      }
    }
  }

  const nowIso = new Date().toISOString();
  const { error: agentErr2 } = await admin
    .from("warehouse_agents")
    .update({
      last_seen_at: nowIso,
      last_discovered_scanners: results,
      last_discovered_at: nowIso,
    })
    .eq("id", agent.id);
  if (agentErr2) {
    console.error(
      `[discovery] agent last_discovered update failed agent=${agent.id} code=${agentErr2.code ?? "?"} message=${agentErr2.message}`,
    );
  }

  // Mark as disconnected any scanner that was previously bound to THIS
  // agent but didn't show up in the current snapshot. Scoped to this
  // agent so multi-agent setups don't fight over the status flag — an
  // agent only owns the connectivity verdict for scanners it last saw.
  const stillVisible = new Set(
    results.filter((r) => r.match).map((r) => r.match!.device_id),
  );
  const { data: bound } = await admin
    .from("station_devices")
    .select("id, connection_status")
    .eq("organization_id", agent.organization_id)
    .eq("device_type", "scanner")
    .eq("bound_agent_id", agent.id);

  const toDisconnect = (bound ?? [])
    .filter((d) => !stillVisible.has(d.id) && d.connection_status !== "disconnected")
    .map((d) => d.id);

  if (toDisconnect.length > 0) {
    const { error: discErr } = await admin
      .from("station_devices")
      .update({ connection_status: "disconnected" })
      .in("id", toDisconnect);
    if (discErr) {
      console.warn(
        `[discovery] disconnect marker update failed agent=${agent.id} count=${toDisconnect.length} code=${discErr.code ?? "?"} message=${discErr.message}`,
      );
    }
  }

  // Tell the agent which scanner device_codes already have a stored
  // identity. The agent uses this to drop env-pinned COM mappings for
  // those codes — pairing in DB wins over legacy SCANNERS_JSON.
  // device_identity is a jsonb that defaults to '{}' so we filter for
  // any object that has at least one key.
  const { data: paired } = await admin
    .from("station_devices")
    .select("device_code, device_identity")
    .eq("organization_id", agent.organization_id)
    .eq("device_type", "scanner")
    .eq("status", "active");
  const pairedDeviceCodes = (paired ?? [])
    .filter((d) => {
      const id = d.device_identity as Record<string, unknown> | null;
      return id && Object.keys(id).length > 0;
    })
    .map((d) => d.device_code);

  return NextResponse.json({
    ok: true,
    ports: results,
    paired_device_codes: pairedDeviceCodes,
  });
}
