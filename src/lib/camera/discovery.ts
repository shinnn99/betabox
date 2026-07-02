import "server-only";
import { networkInterfaces } from "node:os";
import net from "node:net";
import { onvifDiscover, xaddrHost, type OnvifMatch } from "./onvif";
import { probeHttp } from "./probe";

// Camera discovery on the local LAN.
//
// This module is intentionally transport-agnostic and free of any UI/HTTP
// concerns: it should run identically whether invoked from the Next.js
// backend (current deployment, app sits on the same LAN as cameras) or from
// a future warehouse-agent process running at the customer site when the
// product moves to a SaaS topology where the cloud backend can no longer
// see private camera networks.
//
// Discovery is multi-layered. From cheapest/fastest to slowest:
//
//   1. ONVIF WS-Discovery (UDP multicast 239.255.255.250:3702). Sub-5s,
//      catches every ONVIF-compliant camera regardless of subnet (as
//      long as multicast egresses the right NIC).
//   2. TCP port scan over selected RFC1918 /24 subnets. Catches cameras
//      that don't speak ONVIF or have it disabled. We expanded the port
//      list to cover vendor-specific ports (Dahua 37777, Hikvision 8000,
//      etc.).
//   3. Anonymous HTTP probe on hosts that exposed a web port — reads
//      server / <title> hints and checks /onvif/device_service. No
//      credentials are sent.
//
// Hard safety rules enforced here:
//   - only RFC1918 private CIDRs may be scanned
//   - mask must be /24 or smaller to keep the host count bounded
//   - per-port connect attempts use a short timeout
//   - concurrency is bounded
//   - no credentials are ever logged

// Quick-mode ports. Standard RTSP + common camera web UIs.
const QUICK_PORTS: number[] = [554, 80, 8080, 8000, 8899];
// Full-mode ports. Adds vendor-specific service ports (Dahua DH-NetSDK
// 37777, alt web 5000) which are slower to scan but catch oddball setups.
const FULL_PORTS: number[] = [554, 80, 8080, 8000, 8899, 5000, 37777];

function defaultPortTimeoutMs(): number {
  const raw = Number(process.env.CAMERA_DISCOVERY_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 100 && raw <= 10_000) return raw;
  return 1000;
}

const DEFAULT_CONCURRENCY = 64;

export type ScanMode = "quick" | "full";

export interface DiscoveredDevice {
  ip: string;
  open_ports: number[];
  rtsp_port: number | null;
  web_ports: number[];
  onvif_detected: boolean;
  // Concrete ONVIF service URL when WS-Discovery reported one.
  onvif_xaddr: string | null;
  vendor: string | null;
  model: string | null;
  confidence: "onvif_camera" | "likely_camera" | "needs_check";
  suggested_rtsp_paths: string[];
  // Subnet this row was discovered in. Populated when scanning more
  // than one subnet so the UI can group results.
  subnet: string;
}

export interface CandidateSubnet {
  cidr: string;
  interface_name: string;
  is_virtual: boolean;
}

export interface ScanOptions {
  // If specified, we scan only this subnet. Mutually exclusive with `subnets`.
  cidr?: string;
  // If specified, we scan this set of subnets in sequence.
  subnets?: string[];
  ports?: number[];
  portTimeoutMs?: number;
  concurrency?: number;
  // Quick mode skips full port list + skips HTTP probes; relies on
  // ONVIF + minimal TCP for speed.
  mode?: ScanMode;
  // Whether to run the ONVIF WS-Discovery probe. Default true. Off for
  // tests / when the host can't bind multicast.
  enableOnvif?: boolean;
}

export interface ScanResult {
  scan_mode: ScanMode;
  scanned_subnets: string[];
  devices: DiscoveredDevice[];
}

// -- subnet helpers ---------------------------------------------------------

interface SubnetInfo {
  cidr: string;
  hosts: string[];
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

function intToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join(".");
}

function parseCidr(cidr: string): { network: number; prefix: number } {
  const [ipPart, maskPart] = cidr.split("/");
  if (!ipPart || !maskPart) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefix = Number(maskPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const ip = ipToInt(ipPart);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  return { network, prefix };
}

export function validatePrivateCidr(cidr: string): boolean {
  let parsed: { network: number; prefix: number };
  try {
    parsed = parseCidr(cidr);
  } catch {
    return false;
  }
  const { network, prefix } = parsed;
  if (prefix < 24) return false;

  const broadcast =
    prefix === 32 ? network : (network | (0xffffffff >>> prefix)) >>> 0;

  const ranges: Array<[number, number]> = [
    [ipToInt("10.0.0.0"), ipToInt("10.255.255.255")],
    [ipToInt("172.16.0.0"), ipToInt("172.31.255.255")],
    [ipToInt("192.168.0.0"), ipToInt("192.168.255.255")],
  ];

  return ranges.some(([lo, hi]) => network >= lo && broadcast <= hi);
}

function ipToSlash24Cidr(ip: string): string {
  const ipInt = ipToInt(ip);
  const network = (ipInt & 0xffffff00) >>> 0;
  return `${intToIp(network)}/24`;
}

function isVirtualInterfaceName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("docker") ||
    lower.includes("wsl") ||
    lower.includes("vethernet") ||
    lower.includes("hyper-v") ||
    lower.includes("vmware") ||
    lower.includes("virtualbox") ||
    lower.includes("vbox") ||
    lower.includes("vpn") ||
    lower.includes("tap") ||
    lower.includes("tun") ||
    lower.includes("zerotier") ||
    lower.includes("tailscale") ||
    lower.includes("openvpn") ||
    lower.includes("loopback")
  );
}

export function listCandidateSubnets(): CandidateSubnet[] {
  const map = new Map<string, CandidateSubnet>();
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const cidr = ipToSlash24Cidr(addr.address);
      if (!validatePrivateCidr(cidr)) continue;
      const virtual = isVirtualInterfaceName(name);
      const existing = map.get(cidr);
      if (!existing) {
        map.set(cidr, { cidr, interface_name: name, is_virtual: virtual });
      } else if (existing.is_virtual && !virtual) {
        map.set(cidr, { cidr, interface_name: name, is_virtual: false });
      }
    }
  }
  return Array.from(map.values());
}

export function getPrivateSubnets(): string[] {
  return listCandidateSubnets().map((c) => c.cidr);
}

export function rankCandidateSubnets(
  candidates: CandidateSubnet[],
  existingCameraIps: string[] = [],
): CandidateSubnet[] {
  const cameraCidrs = new Set<string>();
  for (const ip of existingCameraIps) {
    try {
      cameraCidrs.add(ipToSlash24Cidr(ip));
    } catch {
      // ignore malformed IPs from DB
    }
  }
  const score = (c: CandidateSubnet): number => {
    if (cameraCidrs.has(c.cidr)) return 0;
    return c.is_virtual ? 2 : 1;
  };
  return [...candidates].sort((a, b) => {
    const s = score(a) - score(b);
    if (s !== 0) return s;
    return ipToInt(a.cidr.split("/")[0]) - ipToInt(b.cidr.split("/")[0]);
  });
}

function enumerateHosts(cidr: string): SubnetInfo {
  const { network, prefix } = parseCidr(cidr);
  const broadcast =
    prefix === 32 ? network : (network | (0xffffffff >>> prefix)) >>> 0;
  const hosts: string[] = [];
  const start = prefix >= 31 ? network : network + 1;
  const end = prefix >= 31 ? broadcast : broadcast - 1;
  for (let i = start; i <= end; i++) {
    hosts.push(intToIp(i));
  }
  return { cidr, hosts };
}

function cidrContains(cidr: string, ip: string): boolean {
  try {
    const { network, prefix } = parseCidr(cidr);
    const ipInt = ipToInt(ip);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) >>> 0 === network;
  } catch {
    return false;
  }
}

// -- port scan --------------------------------------------------------------

function tryConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

export async function scanHostPorts(
  host: string,
  ports: number[],
  timeoutMs: number,
): Promise<number[]> {
  const results = await Promise.all(
    ports.map(async (p) => ((await tryConnect(host, p, timeoutMs)) ? p : null)),
  );
  return results.filter((p): p is number => p !== null);
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          results[idx] = await worker(items[idx], idx);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

// -- classification ---------------------------------------------------------

const COMMON_RTSP_PATHS = [
  "/ch1/main",
  "/ch1/sub",
  "/Streaming/Channels/101",
  "/Streaming/Channels/102",
  "/cam/realmonitor?channel=1&subtype=0",
  "/live",
  "/h264",
];

interface ClassifyInput {
  ip: string;
  openPorts: number[];
  onvif?: OnvifMatch | null;
  httpServer?: string | null;
  httpTitle?: string | null;
  vendorHint?: string | null;
  onvifEndpointAlive?: boolean;
  subnet: string;
}

export function classifyDiscoveredDevice(input: ClassifyInput): DiscoveredDevice {
  const open = [...input.openPorts].sort((a, b) => a - b);
  const rtsp_port = open.includes(554) ? 554 : null;
  const web_ports = open.filter((p) => p === 80 || p === 8080 || p === 8000);
  const onvif_detected =
    !!input.onvif || !!input.onvifEndpointAlive;

  // Confidence ladder:
  //   onvif_camera   — ONVIF responded (multicast or endpoint probe).
  //                    Strongest signal: protocol-level confirmation.
  //   likely_camera  — RTSP port open. Almost always a camera/NVR.
  //   needs_check    — only HTTP/web port open. Could be a router.
  let confidence: DiscoveredDevice["confidence"];
  if (onvif_detected) confidence = "onvif_camera";
  else if (rtsp_port !== null) confidence = "likely_camera";
  else confidence = "needs_check";

  // Vendor/model: prefer ONVIF Scopes (richest), fall back to HTTP hint.
  const vendor = input.onvif?.vendor ?? input.vendorHint ?? null;
  const model = input.onvif?.model ?? null;

  return {
    ip: input.ip,
    open_ports: open,
    rtsp_port,
    web_ports,
    onvif_detected,
    onvif_xaddr: input.onvif?.xaddrs?.[0] ?? null,
    vendor,
    model,
    confidence,
    suggested_rtsp_paths: COMMON_RTSP_PATHS,
    subnet: input.subnet,
  };
}

// -- entry points -----------------------------------------------------------

// Scan a single subnet — wrapper around the multi-subnet path so older
// callers (and tests) keep working.
export async function scanSubnetForCameras(
  options: ScanOptions = {},
): Promise<ScanResult & { subnet: string }> {
  const cidr =
    options.cidr ?? listCandidateSubnets()[0]?.cidr ?? "192.168.1.0/24";
  const res = await scanForCameras({ ...options, subnets: [cidr] });
  return { ...res, subnet: res.scanned_subnets[0] ?? cidr };
}

export async function scanForCameras(
  options: ScanOptions = {},
): Promise<ScanResult> {
  const mode: ScanMode = options.mode ?? "quick";
  const subnets =
    options.subnets ??
    (options.cidr
      ? [options.cidr]
      : listCandidateSubnets().map((c) => c.cidr));

  if (subnets.length === 0) {
    return { scan_mode: mode, scanned_subnets: [], devices: [] };
  }

  for (const s of subnets) {
    if (!validatePrivateCidr(s)) {
      throw new Error(
        `Subnet ${s} không hợp lệ. Chỉ cho phép RFC1918 (/24 trở xuống).`,
      );
    }
  }

  const ports = options.ports?.length
    ? options.ports
    : mode === "full"
      ? FULL_PORTS
      : QUICK_PORTS;
  const portTimeoutMs = options.portTimeoutMs ?? defaultPortTimeoutMs();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const enableOnvif = options.enableOnvif ?? true;

  const started = Date.now();
  console.log(
    `[cameras.discover] scan start mode=${mode} subnets=${subnets.join(",")} ` +
      `ports=${ports.join(",")} timeout=${portTimeoutMs}ms concurrency=${concurrency} ` +
      `onvif=${enableOnvif}`,
  );

  // Phase A — ONVIF WS-Discovery in parallel with TCP scan. We kick the
  // multicast probe off first so its 3-4s window overlaps the port scan
  // and we don't pay the latency twice.
  const onvifTimeoutMs = mode === "quick" ? 3500 : 5000;
  const onvifPromise = enableOnvif
    ? onvifDiscover({ timeoutMs: onvifTimeoutMs }).catch(() => [] as OnvifMatch[])
    : Promise.resolve<OnvifMatch[]>([]);

  // Phase B — TCP port scan across every requested subnet. Hosts from
  // all subnets are pooled together so a slow subnet doesn't sequentially
  // block the next one.
  const allHosts: Array<{ ip: string; subnet: string }> = [];
  for (const s of subnets) {
    for (const ip of enumerateHosts(s).hosts) {
      allHosts.push({ ip, subnet: s });
    }
  }

  const scanResults = await runPool(allHosts, concurrency, async (h) => {
    const open = await scanHostPorts(h.ip, ports, portTimeoutMs);
    return { ip: h.ip, subnet: h.subnet, open };
  });

  const onvifMatches = await onvifPromise;

  // Phase C — merge. We want IPs from EITHER TCP or ONVIF. ONVIF-only
  // hosts (e.g. RTSP/web blocked but ONVIF multicast leaks through) must
  // still appear in the result.
  const byIp = new Map<
    string,
    { ip: string; subnet: string; open: number[]; onvif?: OnvifMatch }
  >();

  for (const r of scanResults) {
    if (r.open.length === 0) continue;
    byIp.set(r.ip, { ip: r.ip, subnet: r.subnet, open: r.open });
  }
  for (const m of onvifMatches) {
    // Determine which scanned subnet the camera belongs to, if any. If
    // the user asked for a specific subnet and the camera is on a
    // different one, we still surface it but tag it as "other".
    const host = xaddrHost(m.xaddrs[0] ?? "") ?? m.ip;
    const ip = host;
    const subnet =
      subnets.find((s) => cidrContains(s, ip)) ?? ipToSlash24Cidr(ip);
    const existing = byIp.get(ip);
    if (existing) {
      existing.onvif = m;
    } else {
      byIp.set(ip, { ip, subnet, open: [], onvif: m });
    }
  }

  // Phase D — anonymous HTTP probe on hosts with a web port. Skipped
  // entirely in quick mode to keep the time-to-first-result tight. In
  // full mode we run probes in parallel with a tight concurrency cap.
  const hostsForHttp =
    mode === "full"
      ? Array.from(byIp.values()).filter((h) =>
          h.open.some((p) => p === 80 || p === 8080 || p === 8000),
        )
      : [];

  const httpResults = await runPool(hostsForHttp, 16, async (h) => {
    const r = await probeHttp(h.ip, h.open);
    return { ip: h.ip, probe: r };
  });
  const httpByIp = new Map(httpResults.map((r) => [r.ip, r.probe]));

  // Phase E — classify into the public DiscoveredDevice shape.
  const devices: DiscoveredDevice[] = Array.from(byIp.values()).map((h) => {
    const probe = httpByIp.get(h.ip);
    return classifyDiscoveredDevice({
      ip: h.ip,
      openPorts: h.open,
      onvif: h.onvif ?? null,
      httpServer: probe?.server_header ?? null,
      httpTitle: probe?.page_title ?? null,
      vendorHint: probe?.vendor_guess ?? null,
      onvifEndpointAlive: probe?.onvif_endpoint_alive ?? false,
      subnet: h.subnet,
    });
  });

  // Stable ordering: confidence first, then IP.
  const conformanceWeight = (d: DiscoveredDevice): number =>
    d.confidence === "onvif_camera"
      ? 0
      : d.confidence === "likely_camera"
        ? 1
        : 2;
  devices.sort((a, b) => {
    const w = conformanceWeight(a) - conformanceWeight(b);
    if (w !== 0) return w;
    return ipToInt(a.ip) - ipToInt(b.ip);
  });

  console.log(
    `[cameras.discover] scan done mode=${mode} subnets=${subnets.length} ` +
      `hosts_open=${devices.length} onvif=${onvifMatches.length} ` +
      `http_probed=${httpResults.length} duration_ms=${Date.now() - started}`,
  );

  return {
    scan_mode: mode,
    scanned_subnets: subnets,
    devices,
  };
}
