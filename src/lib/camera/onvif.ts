import "server-only";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";

// ONVIF WS-Discovery (UDP multicast 239.255.255.250:3702).
//
// ONVIF cameras listen on this multicast group for SOAP "Probe" messages
// and reply unicast with a "ProbeMatch" containing their XAddrs (the
// device service endpoint) and Types/Scopes (which carry vendor/model
// hints under `onvif://www.onvif.org/...` URIs).
//
// We implement WS-Discovery directly via node:dgram instead of pulling
// in an npm package — the protocol is small and avoiding a dependency
// keeps the surface tight. Important quirks we handle here:
//
//   - The probe must be sent from EVERY local IPv4 interface that has
//     a route to its LAN; otherwise multicast only egresses one NIC
//     (typically the OS default route). Most "I can't find my camera"
//     reports stem from this: the camera is on Wi-Fi but Node bound to
//     Ethernet by default. We bind one socket per interface address.
//   - The reply is unicast back to the source port we sent from, so we
//     must keep each socket open for the full window.
//   - Some cameras send multiple ProbeMatches; we de-dup by source IP.
//   - We deliberately do NOT make follow-up SOAP calls (GetDeviceInformation
//     etc.) — those usually require auth, and the discovery row + a
//     vendor hint from Scopes is enough for the UI to render confidence
//     and offer the user a credential prompt.

const MULTICAST_ADDR = "239.255.255.250";
const MULTICAST_PORT = 3702;

export interface OnvifMatch {
  ip: string;
  xaddrs: string[]; // typically a single http URL ending in /onvif/device_service
  types: string[];
  scopes: string[];
  vendor: string | null;
  model: string | null;
}

function buildProbeXml(messageId: string): Buffer {
  // Minimal WS-Discovery v1.1 probe asking for any NetworkVideoTransmitter.
  // Some older cameras only answer the generic dn:NetworkVideoTransmitter
  // type; newer ones also reply to tds:Device. We probe with the OR'd
  // Types token so a single probe satisfies both.
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
    `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ` +
    `xmlns:dn="http://www.onvif.org/ver10/network/wsdl" ` +
    `xmlns:tds="http://www.onvif.org/ver10/device/wsdl">` +
    `<e:Header>` +
    `<w:MessageID>uuid:${messageId}</w:MessageID>` +
    `<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    `<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>` +
    `</e:Header>` +
    `<e:Body>` +
    `<d:Probe><d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types></d:Probe>` +
    `</e:Body>` +
    `</e:Envelope>`;
  return Buffer.from(body, "utf8");
}

// Pull every line that looks like `<tagname>…</tagname>` (namespace-qualified
// or not). We avoid bringing in a full XML parser for what is essentially
// three fields — ONVIF reply payloads are predictable enough that a
// tolerant string extraction is fine, and it dodges XXE concerns from a
// network-attacker-controlled payload.
function extractTagContent(xml: string, localName: string): string[] {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9_]+:)?${localName}>`,
    "gi",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function parseProbeMatch(
  xml: string,
  sourceIp: string,
): OnvifMatch | null {
  const xaddrsRaw = extractTagContent(xml, "XAddrs").join(" ");
  const xaddrs = xaddrsRaw.split(/\s+/).filter((s) => s.length > 0);
  if (xaddrs.length === 0) return null;
  const types = extractTagContent(xml, "Types").flatMap((s) =>
    s.split(/\s+/).filter(Boolean),
  );
  const scopes = extractTagContent(xml, "Scopes").flatMap((s) =>
    s.split(/\s+/).filter(Boolean),
  );

  // Scopes typically look like:
  //   onvif://www.onvif.org/hardware/IPC-HFW2300S
  //   onvif://www.onvif.org/name/HIKVISION%20DS-2CD2046G2-I
  // We grab `hardware`/`name`/`type` as best-effort hints.
  let vendor: string | null = null;
  let model: string | null = null;
  for (const s of scopes) {
    const dec = (v: string) => {
      try {
        return decodeURIComponent(v).trim();
      } catch {
        return v.trim();
      }
    };
    const nameMatch = s.match(/\/name\/([^/]+)/i);
    if (nameMatch && !vendor) vendor = dec(nameMatch[1]);
    const hardwareMatch = s.match(/\/hardware\/([^/]+)/i);
    if (hardwareMatch && !model) model = dec(hardwareMatch[1]);
  }

  return {
    ip: sourceIp,
    xaddrs,
    types,
    scopes,
    vendor,
    model,
  };
}

// Return every local IPv4 address (non-internal, non-zero) — we bind one
// probe socket per address so multicast egresses every NIC the host is
// attached to. This is the difference between finding a Wi-Fi camera and
// not.
function localIpv4Addresses(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address === "0.0.0.0") continue;
      out.push(addr.address);
    }
  }
  return out;
}

export interface OnvifDiscoverOptions {
  timeoutMs?: number;
  // Force a specific local address; otherwise we probe all of them.
  bindAddress?: string;
}

export async function onvifDiscover(
  options: OnvifDiscoverOptions = {},
): Promise<OnvifMatch[]> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const addresses = options.bindAddress
    ? [options.bindAddress]
    : localIpv4Addresses();
  if (addresses.length === 0) return [];

  const found = new Map<string, OnvifMatch>();
  const sockets: dgram.Socket[] = [];

  const cleanup = () => {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        // ignore — socket may already be closed by an error handler
      }
    }
  };

  await new Promise<void>((resolve) => {
    // Wait the full window regardless of how many sockets succeed —
    // ProbeMatch replies trickle in over hundreds of ms, and a bind
    // failure on one NIC shouldn't shorten the window for the others.
    setTimeout(resolve, timeoutMs);

    for (const addr of addresses) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(socket);
      socket.on("error", () => {
        // Swallow — a single NIC failing is fine, others may still work.
      });
      socket.on("message", (msg, rinfo) => {
        const xml = msg.toString("utf8");
        if (!/ProbeMatch/i.test(xml)) return;
        const match = parseProbeMatch(xml, rinfo.address);
        if (!match) return;
        // Last writer wins per IP — newer replies typically carry richer
        // Scopes. De-dup is by source IP, not XAddrs, because a camera
        // can publish multiple service URLs.
        found.set(match.ip, match);
      });
      // Bind ephemeral on the specific interface address so the kernel
      // egresses the probe via that NIC.
      socket.bind({ address: addr, port: 0, exclusive: false }, () => {
        try {
          // setMulticastInterface forces multicast TX to use this NIC
          // even if the routing table would have picked another.
          socket.setMulticastInterface(addr);
          socket.setMulticastTTL(1);
        } catch {
          // setMulticastInterface throws on Windows for some loopback
          // adapters — ignore and rely on the bind() above.
        }
        const probe = buildProbeXml(randomUUID());
        socket.send(probe, MULTICAST_PORT, MULTICAST_ADDR, () => {
          // Send errors are non-fatal — other NICs may still succeed,
          // and even a successful send only matters if a camera replies.
        });
      });
    }
  });

  cleanup();
  return Array.from(found.values());
}

// Extract the bare host (without scheme/port/path) from an XAddrs URL.
// Useful for matching ONVIF matches back to discovered IPs.
export function xaddrHost(xaddr: string): string | null {
  try {
    const u = new URL(xaddr);
    return u.hostname;
  } catch {
    return null;
  }
}
