import { networkInterfaces } from "node:os";
import net from "node:net";
import { onvifDiscover, xaddrHost, type OnvifMatch } from "./lan-onvif";
import { probeHttp } from "./lan-probe";

// MIRROR của beta_cam/src/lib/camera/discovery.ts — copy nguyên logic, bỏ
// `import "server-only"`. Đồng bộ khi sửa gốc.
//
// Chạy trên agent trong kho vì cloud SaaS không thấy được 192.168.x của
// LAN khách. Cloud enqueue command `discover_lan`; hàm này thực thi ở
// agent, callback qua command-result.
//
// Xem file gốc để hiểu các hard rules (chỉ RFC1918, /24 hoặc nhỏ hơn,
// concurrency giới hạn, không log credential).

const QUICK_PORTS: number[] = [554, 80, 8080, 8000, 8899];
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
  onvif_xaddr: string | null;
  vendor: string | null;
  model: string | null;
  confidence: "onvif_camera" | "likely_camera" | "needs_check";
  suggested_rtsp_paths: string[];
  subnet: string;
}

export interface CandidateSubnet {
  cidr: string;
  interface_name: string;
  is_virtual: boolean;
}

export interface ScanOptions {
  cidr?: string;
  subnets?: string[];
  ports?: number[];
  portTimeoutMs?: number;
  concurrency?: number;
  mode?: ScanMode;
  enableOnvif?: boolean;
}

export interface ScanResult {
  scan_mode: ScanMode;
  scanned_subnets: string[];
  devices: DiscoveredDevice[];
}

interface SubnetInfo {
  cidr: string;
  hosts: string[];
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
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

  const broadcast = prefix === 32 ? network : (network | (0xffffffff >>> prefix)) >>> 0;

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

export function rankCandidateSubnets(
  candidates: CandidateSubnet[],
  existingCameraIps: string[] = [],
): CandidateSubnet[] {
  const cameraCidrs = new Set<string>();
  for (const ip of existingCameraIps) {
    try {
      cameraCidrs.add(ipToSlash24Cidr(ip));
    } catch {
      // ignore
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
  const broadcast = prefix === 32 ? network : (network | (0xffffffff >>> prefix)) >>> 0;
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

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
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

async function scanHostPorts(host: string, ports: number[], timeoutMs: number): Promise<number[]> {
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

function classifyDiscoveredDevice(input: ClassifyInput): DiscoveredDevice {
  const open = [...input.openPorts].sort((a, b) => a - b);
  const rtsp_port = open.includes(554) ? 554 : null;
  const web_ports = open.filter((p) => p === 80 || p === 8080 || p === 8000);
  const onvif_detected = !!input.onvif || !!input.onvifEndpointAlive;

  let confidence: DiscoveredDevice["confidence"];
  if (onvif_detected) confidence = "onvif_camera";
  else if (rtsp_port !== null) confidence = "likely_camera";
  else confidence = "needs_check";

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

export async function scanForCameras(options: ScanOptions = {}): Promise<ScanResult> {
  const mode: ScanMode = options.mode ?? "quick";
  // Auto-select subnets: bỏ virtual (Docker/VMware/VPN) mặc định để full
  // mode không phình 60-90s vì quét thêm 172.17.x, và không hiện container
  // expose port 80 như "thiết bị mạng needs_check" gây rối người onboard.
  // Guard fallback: nếu isVirtualInterfaceName() nhận nhầm interface thật
  // (tên lạ) → filter ăn sạch → mảng rỗng → quay lại quét tất cả. Thà quét
  // thừa còn hơn full mode chết câm 0 subnet.
  const autoSubnets = (): string[] => {
    const all = listCandidateSubnets();
    const real = all.filter((c) => !c.is_virtual);
    return (real.length > 0 ? real : all).map((c) => c.cidr);
  };
  const subnets =
    options.subnets ?? (options.cidr ? [options.cidr] : autoSubnets());

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
    `[lan-discovery] scan start mode=${mode} subnets=${subnets.join(",")} ` +
      `ports=${ports.join(",")} timeout=${portTimeoutMs}ms concurrency=${concurrency} ` +
      `onvif=${enableOnvif}`,
  );

  const onvifTimeoutMs = mode === "quick" ? 3500 : 5000;
  const onvifPromise = enableOnvif
    ? onvifDiscover({ timeoutMs: onvifTimeoutMs }).catch(() => [] as OnvifMatch[])
    : Promise.resolve<OnvifMatch[]>([]);

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

  const byIp = new Map<
    string,
    { ip: string; subnet: string; open: number[]; onvif?: OnvifMatch }
  >();

  for (const r of scanResults) {
    if (r.open.length === 0) continue;
    byIp.set(r.ip, { ip: r.ip, subnet: r.subnet, open: r.open });
  }
  for (const m of onvifMatches) {
    const host = xaddrHost(m.xaddrs[0] ?? "") ?? m.ip;
    const ip = host;
    const subnet = subnets.find((s) => cidrContains(s, ip)) ?? ipToSlash24Cidr(ip);
    const existing = byIp.get(ip);
    if (existing) {
      existing.onvif = m;
    } else {
      byIp.set(ip, { ip, subnet, open: [], onvif: m });
    }
  }

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

  const conformanceWeight = (d: DiscoveredDevice): number =>
    d.confidence === "onvif_camera" ? 0 : d.confidence === "likely_camera" ? 1 : 2;
  devices.sort((a, b) => {
    const w = conformanceWeight(a) - conformanceWeight(b);
    if (w !== 0) return w;
    return ipToInt(a.ip) - ipToInt(b.ip);
  });

  console.log(
    `[lan-discovery] scan done mode=${mode} subnets=${subnets.length} ` +
      `hosts_open=${devices.length} onvif=${onvifMatches.length} ` +
      `http_probed=${httpResults.length} duration_ms=${Date.now() - started}`,
  );

  return {
    scan_mode: mode,
    scanned_subnets: subnets,
    devices,
  };
}
