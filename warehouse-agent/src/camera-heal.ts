import { AGENT_API_PATHS } from "./agent-api-paths";
import { findIpByMac, normalizeMac } from "./lan-arp";
import { tcpConnect } from "./camera-probe";
import { scanForCameras, type DiscoveredDevice } from "./lan-discovery";
import { describeFetchError, fetchWithRetrySigned } from "./fetch-error";
import { signBodyV2 } from "./signing";

/**
 * E.1 Bước A lớp 3 — tự dò lại IP camera theo MAC.
 *
 * Khi nào chạy: camera probe hỏng liên tiếp, tức "IP này không còn nghe
 * RTSP nữa". Nguyên nhân phổ biến nhất trong kho không phải camera hỏng mà
 * là DHCP cấp IP khác sau khi mất điện hoặc reboot router.
 *
 * Cách làm: quét đúng subnet cũ của camera, tìm thiết bị có MAC trùng, báo
 * IP mới về cloud. Agent KHÔNG tự ghi DB — cloud kiểm tra lại MAC rồi mới
 * cập nhật (xem `src/app/api/agent/camera-ip-healed/route.ts`).
 *
 * Ba ràng buộc cố ý:
 *   - Camera chưa có MAC thì bỏ qua. Không có gì đối chiếu thì cập nhật IP
 *     chỉ là đoán, mà đoán sai nghĩa là trỏ camera của kho này sang thiết
 *     bị khác.
 *   - Có thời gian chờ giữa hai lần thử. Đo thật 16/09 trên LAN kho: quét
 *     /24 chế độ nhanh mất ~4,7s và mở 254 kết nối TCP — rẻ hơn dự tính
 *     nhưng vẫn chạy trên chính máy đang ghi hình, nên không lặp liên tục
 *     cho một camera đã chết hẳn.
 *   - Đúng một camera mỗi lượt. Nhiều camera hỏng cùng lúc gần như luôn
 *     là mất mạng/mất điện cả cụm, không phải đổi IP — quét lúc đó vô ích.
 */

export const HEAL_AFTER_CONSECUTIVE_FAILS = 3;
export const HEAL_COOLDOWN_MS = 10 * 60_000;

export interface HealCandidate {
  cameraId: string;
  cameraCode: string;
  ip: string;
  macAddress: string | null;
  consecutiveFails: number;
}

/**
 * Quyết định có nên quét lại cho camera này không. Hàm thuần để test.
 */
export function shouldAttemptHeal(input: {
  candidate: HealCandidate;
  lastAttemptAtMs: number | null;
  nowMs: number;
}): boolean {
  const { candidate } = input;
  if (!normalizeMac(candidate.macAddress)) return false;
  if (candidate.consecutiveFails < HEAL_AFTER_CONSECUTIVE_FAILS) return false;
  if (input.lastAttemptAtMs === null) return true;
  return input.nowMs - input.lastAttemptAtMs >= HEAL_COOLDOWN_MS;
}

/** Subnet /24 của một IPv4. Trả null nếu IP không hợp lệ. */
export function slash24Of(ip: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * Tìm IP mới của camera trong kết quả quét.
 *
 * Chỉ khớp MAC. KHÔNG dùng vendor/model làm căn cứ phụ: hai camera cùng
 * model trong một kho là chuyện bình thường, khớp theo model sẽ trỏ nhầm.
 */
export function pickHealedIp(
  devices: DiscoveredDevice[],
  target: { macAddress: string; currentIp: string },
): string | null {
  const wanted = normalizeMac(target.macAddress);
  if (!wanted) return null;
  const matches = devices.filter((d) => normalizeMac(d.mac_address) === wanted);
  // Hai thiết bị cùng MAC = bảng ARP không đáng tin ở lần quét này. Thà
  // không chữa còn hơn chữa sai.
  if (matches.length !== 1) return null;
  const found = matches[0].ip;
  return found === target.currentIp ? null : found;
}

export interface HealResult {
  cameraId: string;
  previousIp: string;
  newIp: string;
}

/**
 * Quét subnet cũ và báo IP mới về cloud. Trả null khi không tìm thấy hoặc
 * cloud từ chối — cả hai đều là kết cục bình thường, không phải lỗi.
 */
export async function healCameraIp(params: {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  candidate: HealCandidate;
  scan?: typeof scanForCameras;
  /** Cho test: thay bước tra bảng ARP. */
  findIpByMac?: typeof findIpByMac;
  /** Cho test: thay bước xác nhận cổng RTSP. */
  checkRtsp?: (ip: string) => Promise<{ ok: boolean; latencyMs: number | null }>;
}): Promise<HealResult | null> {
  const mac = normalizeMac(params.candidate.macAddress);
  if (!mac) return null;
  const cidr = slash24Of(params.candidate.ip);
  if (!cidr) return null;

  console.warn(
    `[camera-heal] camera=${params.candidate.cameraCode} mất kết nối ở ${params.candidate.ip}, quét lại ${cidr} theo MAC ${mac}`,
  );

  const subnetPrefix = `${cidr.slice(0, cidr.lastIndexOf("."))}.`;
  const findInArp = params.findIpByMac ?? findIpByMac;

  // Bước 1: hỏi bảng ARP trước. Rẻ (vài ms) và đáng tin hơn quét cổng,
  // vì thiết bị trả lời ARP kể cả khi bắt tay TCP 1 giây không kịp.
  let newIp = await findInArp(mac, { subnetPrefix });

  // Bước 2: ARP chưa biết IP mới (camera vừa đổi sang IP mà máy này chưa
  // từng nói chuyện) thì mới quét — quét cũng chính là cách đánh thức ARP.
  if (!newIp || newIp === params.candidate.ip) {
    const scan = params.scan ?? scanForCameras;
    let devices: DiscoveredDevice[];
    try {
      // Quét nhanh: chỉ cần thấy thiết bị và lấy MAC, không cần dò HTTP.
      const result = await scan({ cidr, mode: "quick" });
      devices = result.devices;
    } catch (error) {
      console.warn(`[camera-heal] quét thất bại: ${(error as Error).message}`);
      return null;
    }
    newIp =
      pickHealedIp(devices, { macAddress: mac, currentIp: params.candidate.ip }) ??
      // Quét xong bảng ARP đã ấm: tra lại lần nữa. Đây là lưới hứng cho
      // đúng trường hợp đã gặp thật — máy bận nên quét bỏ sót host, nhưng
      // ARP vẫn ghi nhận nó.
      (await findInArp(mac, { subnetPrefix }));
  }

  if (!newIp || newIp === params.candidate.ip) {
    console.warn(
      `[camera-heal] không thấy MAC ${mac} trong ${cidr} — camera có thể đã tắt hoặc chuyển sang subnet khác`,
    );
    return null;
  }

  // Bước 3: xác nhận IP mới thật sự đang phục vụ RTSP trước khi báo cloud.
  // Khớp MAC đã mạnh, nhưng một bản ghi ARP cũ có thể trỏ vào thiết bị đã
  // tắt; báo nhầm là camera "online" mà không có hình.
  const reachable = params.checkRtsp ?? ((ip: string) => tcpConnect(ip, 554));
  const check = await reachable(newIp);
  if (!check.ok) {
    console.warn(
      `[camera-heal] ${newIp} khớp MAC nhưng không mở cổng RTSP — bỏ qua lần này`,
    );
    return null;
  }

  const body = JSON.stringify({
    camera_id: params.candidate.cameraId,
    ip: newIp,
    mac_address: mac,
  });
  try {
    const res = await fetchWithRetrySigned(
      `${params.backendUrl}${AGENT_API_PATHS.cameraIpHealed}`,
      () => ({
        method: "POST",
        headers: signBodyV2({
          agentCode: params.agentCode,
          agentSecret: params.agentSecret,
          method: "POST",
          canonicalPath: AGENT_API_PATHS.cameraIpHealed,
          body,
        }),
        body,
        redirect: "manual",
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[camera-heal] cloud từ chối ${res.status}: ${text.slice(0, 200)}`,
      );
      return null;
    }
  } catch (error) {
    console.warn(`[camera-heal] báo cloud thất bại: ${describeFetchError(error)}`);
    return null;
  }

  console.warn(
    `[camera-heal] camera=${params.candidate.cameraCode} IP mới ${params.candidate.ip} → ${newIp}`,
  );
  return { cameraId: params.candidate.cameraId, previousIp: params.candidate.ip, newIp };
}
