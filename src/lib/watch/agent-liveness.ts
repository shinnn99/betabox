import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_OFFLINE_THRESHOLD_SECONDS } from "./config";

/**
 * Liveness của agent trong một org — đọc `warehouse_agents.last_seen_at`
 * và derive `is_offline` theo NOW() lúc gọi.
 *
 * Dùng chung cho:
 *   - POST /api/order-proof/[pe_id]/watch (state machine 3c/3d).
 *   - GET  /api/order-proof/scans        (badge "Kho offline" trong list).
 *
 * KHÔNG chép logic ra hai chỗ — mọi caller import hàm này. Bài học
 * nguồn-sự-thật-duy-nhất: cùng cột chưa đủ, phải cùng HÀM.
 *
 * Model hiện tại per-org: 1 org 1 agent (Betacom 2026-07-03). Cọc
 * multi-warehouse (thêm warehouse_id vào warehouse_agents) đã ghi trong
 * project_camera_probe_tech_debt_cocs — kích hoạt khi org đầu tiên có
 * kho thứ 2 với agent riêng. Đến lúc đó SỬA HÀM NÀY để nhận thêm
 * warehouse_id — CẢ /watch + list cùng lên đúng một lượt, không lệch.
 *
 * Vì sao dùng `.limit(1)` + lấy `data[0]` thay vì `.maybeSingle()`:
 *   `.maybeSingle()` THROW khi query trả > 1 row → org có agent thứ 2
 *   sẽ crash 500 ở production trước khi ai kịp thấy badge sai. Vi phạm
 *   nguyên tắc "thêm-agent-không-vỡ" (project_camera_probe_tech_debt_cocs
 *   cọc #6). `.limit(1)` + `data[0]` chỉ sai-nhẹ (lấy agent-mới-nhất
 *   thay vì đúng-warehouse), KHÔNG crash — chấp nhận được ở giai đoạn
 *   1-kho, và test âm "thêm agent 2 không crash" pass.
 */
export interface AgentLiveness {
  agent_id: string | null;
  last_seen_at: string | null;
  is_offline: boolean;
  offline_duration_seconds: number;
}

const OFFLINE_INFINITY_SECONDS = 999_999_999;

export async function readAgentLiveness(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<AgentLiveness> {
  const { data } = await admin
    .from("warehouse_agents")
    .select("id, last_seen_at")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1);

  const agent = (data ?? [])[0] as
    | { id: string; last_seen_at: string | null }
    | undefined;

  if (!agent) {
    return {
      agent_id: null,
      last_seen_at: null,
      is_offline: true,
      offline_duration_seconds: OFFLINE_INFINITY_SECONDS,
    };
  }
  if (!agent.last_seen_at) {
    return {
      agent_id: agent.id,
      last_seen_at: null,
      is_offline: true,
      offline_duration_seconds: OFFLINE_INFINITY_SECONDS,
    };
  }
  const lastSeenMs = new Date(agent.last_seen_at).getTime();
  const nowMs = Date.now();
  const offlineDurationSeconds = Math.max(
    0,
    Math.floor((nowMs - lastSeenMs) / 1000),
  );
  return {
    agent_id: agent.id,
    last_seen_at: agent.last_seen_at,
    is_offline: offlineDurationSeconds > AGENT_OFFLINE_THRESHOLD_SECONDS,
    offline_duration_seconds: offlineDurationSeconds,
  };
}
