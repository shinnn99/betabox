import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeMac } from "./mac";

/**
 * Tìm agent nên PHỤC VỤ một camera vừa đăng nhập: chính agent đã quét thấy
 * nó trong LAN của mình.
 *
 * Vì sao là agent đã quét, không phải agent của bàn: agent chỉ với tới được
 * camera cùng LAN với máy nó chạy. Kết quả quét LAN là bằng chứng vật lý
 * duy nhất cho điều đó. Gán theo bàn thì một camera ở kho A có thể bị giao
 * cho agent ở kho B — agent đó không bao giờ kết nối được.
 *
 * Vì sao phải gán ngay lúc đăng nhập: agent chỉ dựng đường livestream, đọc
 * QR và ghi hình cho camera có `agent_id` trỏ về chính nó. Camera tạo qua
 * "Thêm thiết bị" trước đây nằm với `agent_id = null`, không agent nào nhìn
 * thấy, và trình duyệt nhận WHEP 400 "path is not configured" mà không có
 * một dòng cảnh báo nào (camera EZVIZ CAM_TEST, 17/09/2026).
 *
 * Tra ở phía máy chủ, không tin trường agent do trình duyệt gửi lên.
 */

/** Số lệnh quét gần nhất đem ra đối chiếu. Quét cũ hơn coi như hết giá trị. */
const RECENT_DISCOVERIES = 20;

export interface DiscoveredRow {
  agent_id: string;
  result: { devices?: Array<{ ip?: string; mac_address?: string | null }> } | null;
}

/**
 * Phần quyết định, tách riêng để test. Hàm thuần — không đụng DB.
 *
 * `discoveries` phải xếp mới nhất trước: camera đổi mạng thì lần quét gần
 * nhất mới phản ánh máy nào đang với tới nó.
 */
export function pickDiscoveringAgent(input: {
  discoveries: DiscoveredRow[];
  camera: { ip: string; mac_address?: string | null };
  activeAgentIds: string[];
}): string | null {
  const mac = normalizeMac(input.camera.mac_address ?? null);

  // Khớp MAC trước (định danh ổn định), IP sau (chỉ còn là phòng khi quét
  // không lấy được MAC).
  if (mac) {
    for (const row of input.discoveries) {
      const devices = row.result?.devices ?? [];
      if (devices.some((d) => normalizeMac(d.mac_address ?? null) === mac)) {
        return row.agent_id;
      }
    }
  }
  for (const row of input.discoveries) {
    const devices = row.result?.devices ?? [];
    if (devices.some((d) => d.ip === input.camera.ip)) return row.agent_id;
  }

  // Không có lần quét nào thấy camera (thêm tay bằng IP). Tổ chức chỉ có
  // đúng một agent thì không có gì để nhầm — giao cho nó. Nhiều agent thì
  // KHÔNG đoán: để trống còn hơn giao cho một máy không với tới được.
  return input.activeAgentIds.length === 1 ? input.activeAgentIds[0] : null;
}

export async function findDiscoveringAgent(
  admin: SupabaseClient,
  organizationId: string,
  camera: { ip: string; mac_address?: string | null },
): Promise<string | null> {
  const [{ data: rows }, { data: agents }] = await Promise.all([
    admin
      .from("agent_commands")
      .select("agent_id, result")
      .eq("organization_id", organizationId)
      .eq("type", "discover_lan")
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(RECENT_DISCOVERIES),
    admin
      .from("warehouse_agents")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("status", "active"),
  ]);

  return pickDiscoveringAgent({
    discoveries: (rows ?? []) as DiscoveredRow[],
    camera,
    activeAgentIds: ((agents ?? []) as Array<{ id: string }>).map((a) => a.id),
  });
}

/**
 * Gán camera cho agent đã quét thấy nó, nếu camera chưa thuộc agent nào.
 * Không đè agent đã có: camera đang chạy ổn thì không được bị chuyển máy
 * chỉ vì ai đó bấm lưu lại.
 */
export async function bindCameraToDiscoveringAgent(
  admin: SupabaseClient,
  organizationId: string,
  camera: { id: string; ip: string; mac_address?: string | null; agent_id?: string | null },
): Promise<string | null> {
  if (camera.agent_id) return camera.agent_id;
  const agentId = await findDiscoveringAgent(admin, organizationId, camera);
  if (!agentId) return null;
  await admin
    .from("cameras")
    .update({ agent_id: agentId })
    .eq("organization_id", organizationId)
    .eq("id", camera.id)
    .is("agent_id", null);
  return agentId;
}
