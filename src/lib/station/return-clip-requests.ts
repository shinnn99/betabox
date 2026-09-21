import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { enqueueCutClip } from "@/lib/agent-commands/enqueue";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";

type Admin = ReturnType<typeof createAdminClient>;

/** Mỗi lượt chỉ xử lý vài kiện — kho bình thường không có nhiều hồ sơ mới. */
const MAX_PER_SWEEP = 5;

/**
 * Cắt clip NGAY cho kiện hoàn có vấn đề, không chờ ai mở xem.
 *
 * Vì sao khác đơn đi: đơn đi chỉ cắt khi có người mở, vì phần lớn đơn không
 * ai xem. Kiện hoàn có vấn đề thì ngược lại — nó gần như chắc chắn cần dùng
 * làm bằng chứng, và hạn khiếu nại của sàn ngắn. Cắt sẵn nghĩa là lúc chủ
 * kho mở hồ sơ thì video đã có, không phải chờ máy kho.
 *
 * Chạy theo hồ sơ (`return_claims` đang mở) thay vì theo lượt đóng kiện, vì
 * kiện có thể đóng bằng đường chạy hoàn toàn trong database (đóng ca, đổi
 * chế độ) — cloud không có chỗ nào để hứng sự kiện đó. Hồ sơ là dấu vết
 * chung của cả tám đường đóng kiện.
 *
 * Lỗi ở đây không bao giờ được chặn nhịp gọi: trả 0.
 */
export async function requestClipsForOpenReturnClaims(params: {
  admin: Admin;
  organizationId: string;
}): Promise<number> {
  const { data: claims, error } = await params.admin
    .from("return_claims")
    .select("id, packing_event_id")
    .eq("organization_id", params.organizationId)
    .eq("status", "open")
    .order("deadline_at", { ascending: true })
    .limit(MAX_PER_SWEEP);

  if (error) {
    console.warn(`[return-clip] không đọc được hồ sơ: ${error.message}`);
    return 0;
  }
  if (!claims || claims.length === 0) return 0;

  const eventIds = claims.map((c) => c.packing_event_id as string);

  // Kiện đã có clip (đang cắt, sẵn sàng, hoặc đã lỗi) thì không xin cắt lại:
  // lỗi cắt cần người bấm Thử lại, không nên lặp vô hạn ở vòng quét.
  const { data: clips } = await params.admin
    .from("order_proof_clips")
    .select("packing_event_id")
    .in("packing_event_id", eventIds);
  const hasClip = new Set((clips ?? []).map((c) => c.packing_event_id as string));

  const pending = eventIds.filter((id) => !hasClip.has(id));
  if (pending.length === 0) return 0;

  // Máy kho phải online mới cắt được; offline thì để lần quét sau.
  const liveness = await readAgentLiveness(params.admin, params.organizationId);
  if (liveness.is_offline || !liveness.agent_id) return 0;

  let requested = 0;
  for (const eventId of pending) {
    try {
      const outcome = await enqueueCutClip({
        organizationId: params.organizationId,
        agentId: liveness.agent_id,
        packingEventId: eventId,
      });
      if (outcome.ok) {
        requested += 1;
        console.warn(`[return-clip] đã xin cắt clip cho kiện hoàn pe=${eventId}`);
      } else {
        console.warn(`[return-clip] chưa cắt được pe=${eventId}: ${outcome.reason}`);
      }
    } catch (err) {
      console.warn(`[return-clip] lỗi khi xin cắt pe=${eventId}: ${(err as Error).message}`);
    }
  }
  return requested;
}
