import { SerialPort } from "serialport";
import { signBody } from "./signing";

/**
 * What we report up to the backend for one serial port. Field names match
 * the ones the discovery endpoint expects. We coerce vendor/product IDs to
 * lowercase hex with no `0x` prefix because that's what node-serialport
 * usually returns; the backend stores the normalized form.
 */
export interface PortInfo {
  path: string;
  manufacturer: string | null;
  product: string | null;
  serial_number: string | null;
  vendor_id: string | null;
  product_id: string | null;
  pnp_id: string | null;
  friendly_name: string | null;
}

export interface DiscoveryMatch {
  device_id: string;
  device_code: string;
  match_kind: string;
}

export interface DiscoveryResult {
  /** Ports as the backend understood them, with optional match info. */
  ports: Array<{
    path: string;
    identity: Record<string, string>;
    match: DiscoveryMatch | null;
  }>;
  /**
   * Scanner device_codes that already have device_identity stored in the
   * DB. The agent uses this to suppress env-pinned COM entries for those
   * codes — once a scanner has been paired through the UI, the legacy
   * SCANNERS_JSON pin must not override the identity-based mapping.
   */
  paired_device_codes?: string[];
}

function toLowerHex(v: string | undefined): string | null {
  if (!v) return null;
  const cleaned = String(v).replace(/^0x/i, "").toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

export async function listLocalPorts(): Promise<PortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => {
    const info = p as {
      path: string;
      manufacturer?: string;
      friendlyName?: string;
      pnpId?: string;
      serialNumber?: string;
      vendorId?: string;
      productId?: string;
      locationId?: string;
      productName?: string;
    };
    return {
      path: info.path,
      manufacturer: info.manufacturer ?? null,
      product: info.productName ?? null,
      friendly_name: info.friendlyName ?? null,
      pnp_id: info.pnpId ?? null,
      serial_number: info.serialNumber ?? null,
      vendor_id: toLowerHex(info.vendorId),
      product_id: toLowerHex(info.productId),
    };
  });
}

export async function postDiscovery(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  ports: PortInfo[];
}): Promise<DiscoveryResult | null> {
  const body = JSON.stringify({ ports: params.ports });
  const headers = signBody({
    agentCode: params.agentCode,
    agentSecret: params.agentSecret,
    body,
  });
  try {
    const res = await fetch(`${params.backendUrl}/api/warehouse/discovery`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[discovery] POST failed ${res.status}: ${text.slice(0, 200)}`,
      );
      return null;
    }
    const json = (await res.json()) as DiscoveryResult;
    console.log(
      `[discovery] reported ${params.ports.length} port(s), matched ${json.ports.filter((p) => p.match).length}`,
    );
    return json;
  } catch (err) {
    console.error(`[discovery] POST threw: ${(err as Error).message}`);
    return null;
  }
}
