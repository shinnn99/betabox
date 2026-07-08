import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";

// MIRROR của beta_cam/src/lib/camera/onvif.ts — copy nguyên logic, bỏ
// `import "server-only"` để chạy được ở agent Node thuần.
//
// Đồng bộ hoá: nếu sửa cloud, sửa cả đây. Không import chéo vì agent phải
// build độc lập (đóng gói bằng pkg).
//
// Xem file gốc để hiểu vì sao phải bind mỗi interface một socket, vì sao
// không dùng XML parser đầy đủ, v.v.

const MULTICAST_ADDR = "239.255.255.250";
const MULTICAST_PORT = 3702;

export interface OnvifMatch {
  ip: string;
  xaddrs: string[];
  types: string[];
  scopes: string[];
  vendor: string | null;
  model: string | null;
}

function buildProbeXml(messageId: string): Buffer {
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

function parseProbeMatch(xml: string, sourceIp: string): OnvifMatch | null {
  const xaddrsRaw = extractTagContent(xml, "XAddrs").join(" ");
  const xaddrs = xaddrsRaw.split(/\s+/).filter((s) => s.length > 0);
  if (xaddrs.length === 0) return null;
  const types = extractTagContent(xml, "Types").flatMap((s) =>
    s.split(/\s+/).filter(Boolean),
  );
  const scopes = extractTagContent(xml, "Scopes").flatMap((s) =>
    s.split(/\s+/).filter(Boolean),
  );

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

  return { ip: sourceIp, xaddrs, types, scopes, vendor, model };
}

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
        // ignore
      }
    }
  };

  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);

    for (const addr of addresses) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(socket);
      socket.on("error", () => {
        // ignore per-NIC failure
      });
      socket.on("message", (msg, rinfo) => {
        const xml = msg.toString("utf8");
        if (!/ProbeMatch/i.test(xml)) return;
        const match = parseProbeMatch(xml, rinfo.address);
        if (!match) return;
        found.set(match.ip, match);
      });
      socket.bind({ address: addr, port: 0, exclusive: false }, () => {
        try {
          socket.setMulticastInterface(addr);
          socket.setMulticastTTL(1);
        } catch {
          // ignore Windows loopback quirks
        }
        const probe = buildProbeXml(randomUUID());
        socket.send(probe, MULTICAST_PORT, MULTICAST_ADDR, () => {
          // send errors non-fatal
        });
      });
    }
  });

  cleanup();
  return Array.from(found.values());
}

export function xaddrHost(xaddr: string): string | null {
  try {
    const u = new URL(xaddr);
    return u.hostname;
  } catch {
    return null;
  }
}
