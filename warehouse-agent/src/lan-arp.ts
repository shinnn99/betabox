import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Lấy MAC của thiết bị trong LAN từ bảng ARP của Windows.
 *
 * Vì sao dùng ARP chứ không hỏi camera:
 *   Không phải camera nào cũng trả MAC qua ONVIF, và hỏi được thì cũng
 *   phải có credential — trong khi lúc quét LAN ta chưa có. ARP thì luôn
 *   có, miễn là vừa nói chuyện với thiết bị.
 *
 * GIỚI HẠN QUAN TRỌNG — chỉ dùng được trong cùng subnet:
 *   Gói tin đi qua router sẽ mang MAC của router chứ không phải của thiết
 *   bị. Nếu nhận nhầm, mọi camera bên kia router sẽ có cùng một MAC và hệ
 *   thống sẽ coi chúng là một. `resolveMacAddresses` vì thế chỉ tra IP
 *   thuộc subnet của chính máy agent, và `countDistinctHostsPerMac` để
 *   caller phát hiện trường hợp một MAC ứng nhiều IP mà bỏ qua.
 */

/** Chuẩn hoá mọi kiểu viết MAC về `AA:BB:CC:DD:EE:FF`. Trả null nếu không hợp lệ. */
export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return null;
  // MAC toàn 0 hoặc broadcast = entry rác trong bảng ARP, không phải thiết bị.
  if (hex === "000000000000" || hex === "FFFFFFFFFFFF") return null;
  return hex.match(/.{2}/g)!.join(":");
}

/**
 * Bóc cặp IP → MAC từ stdout của `arp -a`.
 *
 * Hàm thuần để test được mà không cần máy Windows thật. Chấp nhận cả
 * định dạng Windows (`192.168.1.10   aa-bb-cc-dd-ee-ff   dynamic`) lẫn
 * Unix (`? (192.168.1.10) at aa:bb:cc:dd:ee:ff [ether] on eth0`).
 */
export function parseArpTable(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  // Tìm IP và MAC độc lập trên cùng một dòng, thay vì một mẫu liền mạch:
  // phần ngăn giữa hai giá trị khác nhau theo hệ điều hành, và ở Unix nó
  // chứa chữ "at" — vốn toàn ký tự hex, nên mọi mẫu kiểu "phần ngăn =
  // không phải hex" đều khớp hụt.
  const ipRe = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
  const macRe = /\b([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})\b/;
  for (const raw of stdout.split(/\r?\n/)) {
    const ipMatch = ipRe.exec(raw);
    const macMatch = macRe.exec(raw);
    if (!ipMatch || !macMatch) continue;
    const mac = normalizeMac(macMatch[1]);
    if (!mac) continue;
    // Entry tĩnh của multicast/broadcast không phải thiết bị thật.
    if (/static/i.test(raw) && /^(01:00:5E|FF:FF)/.test(mac)) continue;
    out.set(ipMatch[1], mac);
  }
  return out;
}

/**
 * Đếm số IP khác nhau đang dùng chung một MAC.
 *
 * MAC ứng nhiều IP = gần như chắc chắn đó là MAC của router (thiết bị nằm
 * ngoài subnet). Caller phải bỏ các MAC này thay vì gán cho camera.
 */
export function countDistinctHostsPerMac(table: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mac of table.values()) counts.set(mac, (counts.get(mac) ?? 0) + 1);
  return counts;
}

/**
 * Loại các MAC đáng ngờ (một MAC ứng nhiều IP) khỏi bảng tra cứu.
 * Thà không có MAC còn hơn có MAC sai — MAC sai sẽ gây ghi đè nhầm camera.
 */
export function dropAmbiguousMacs(table: Map<string, string>): Map<string, string> {
  const counts = countDistinctHostsPerMac(table);
  const out = new Map<string, string>();
  for (const [ip, mac] of table) {
    if ((counts.get(mac) ?? 0) > 1) continue;
    out.set(ip, mac);
  }
  return out;
}

/**
 * Chạm vào thiết bị để bảo đảm nó có mặt trong bảng ARP.
 *
 * Bảng ARP chỉ chứa thiết bị vừa trao đổi gói tin. Ta mở một kết nối TCP
 * ngắn tới cổng đã biết là mở (thường 554) rồi đóng ngay — chỉ cần lớp
 * dưới gửi ARP request là đủ, không quan tâm TCP có bắt tay xong không.
 */
export async function touchHost(ip: string, port: number, timeoutMs = 600): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = new net.Socket();
    const done = () => {
      socket.removeAllListeners();
      socket.destroy();
      resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", done);
    socket.once("timeout", done);
    socket.once("error", done);
    socket.connect(port, ip);
  });
}

export interface ResolveMacOptions {
  /** Cổng dùng để chạm vào thiết bị; mặc định RTSP. */
  touchPort?: number;
  /** Cho test: thay lệnh `arp -a`. */
  readArpTable?: () => Promise<Map<string, string>>;
  /** Cho test: thay bước chạm. */
  touch?: (ip: string, port: number) => Promise<void>;
}

export async function readSystemArpTable(): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync("arp", ["-a"], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseArpTable(stdout);
  } catch (error) {
    console.warn(`[lan-arp] không đọc được bảng ARP: ${(error as Error).message}`);
    return new Map();
  }
}

/**
 * Tìm IP hiện tại của một MAC ngay trong bảng ARP của hệ điều hành.
 *
 * Vì sao cần hàm này bên cạnh `resolveMacAddresses`: quét cổng để phát
 * hiện thiết bị có timeout 1 giây, mà nó chạy trên chính máy đang ghi
 * hình. Đo thật 16/09: cùng một subnet, lúc máy rảnh quét thấy 7 thiết bị
 * (6 MAC), lúc agent vừa khởi động và đang bận chỉ thấy 3 thiết bị
 * (2 MAC) — camera cần tìm rơi mất. Bảng ARP thì đã có sẵn câu trả lời và
 * đọc mất vài mili giây.
 *
 * Trả null khi không thấy, hoặc khi MAC xuất hiện ở nhiều IP (bảng ARP
 * không đáng tin lúc đó — thà không chữa còn hơn chữa sai).
 */
export async function findIpByMac(
  macAddress: string,
  options: {
    /** Chỉ chấp nhận IP thuộc tiền tố này, ví dụ "192.168.31." */
    subnetPrefix: string;
    readArpTable?: () => Promise<Map<string, string>>;
  },
): Promise<string | null> {
  const wanted = normalizeMac(macAddress);
  if (!wanted) return null;
  const table = dropAmbiguousMacs(
    await (options.readArpTable ?? readSystemArpTable)(),
  );
  const hits: string[] = [];
  for (const [ip, mac] of table) {
    if (mac === wanted && ip.startsWith(options.subnetPrefix)) hits.push(ip);
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Tra MAC cho danh sách IP. IP nào không tra được thì vắng mặt trong kết
 * quả — caller phải chịu được việc thiếu MAC, không được coi đó là lỗi.
 */
export async function resolveMacAddresses(
  ips: string[],
  options: ResolveMacOptions = {},
): Promise<Map<string, string>> {
  if (ips.length === 0) return new Map();
  const touch = options.touch ?? ((ip, port) => touchHost(ip, port));
  const touchPort = options.touchPort ?? 554;
  const readTable = options.readArpTable ?? readSystemArpTable;

  // Chạm song song có giới hạn: 32 kết nối ngắn là đủ nhanh cho một /24
  // mà không làm nghẽn card mạng của máy bàn đang ghi hình.
  const batchSize = 32;
  for (let i = 0; i < ips.length; i += batchSize) {
    await Promise.all(ips.slice(i, i + batchSize).map((ip) => touch(ip, touchPort)));
  }

  const table = dropAmbiguousMacs(await readTable());
  const wanted = new Set(ips);
  const out = new Map<string, string>();
  for (const [ip, mac] of table) {
    if (wanted.has(ip)) out.set(ip, mac);
  }
  return out;
}
