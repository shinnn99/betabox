import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isError,
  requirePermissionStrict,
  roleHasPermission,
} from "@/lib/supabase/guard";
import { clipBucketValid, type ScanClipSummary } from "@/lib/order-proof/service";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";
import { enqueueCutClip } from "@/lib/agent-commands/enqueue";
import { evaluateProofClipGate } from "@/lib/order-proof/proof-clip-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe-retry S7 2026-07-06:
 *
 * User bấm [Thử lại] → tạo generation MỚI song song với ready cũ.
 * KHÔNG wipe row, KHÔNG xóa bucket, KHÔNG xóa command cũ.
 *
 * Luồng:
 *   1. Nếu có clip ready hiện tại → nhớ id (oldReady.id) làm
 *      `replacesClipId`. Nếu chưa có ready (hoặc chỉ có failed), coi
 *      như lần cắt đầu → `replacesClipId = null`.
 *   2. Enqueue safe cut_clip với `replacesClipId`.
 *      - RPC atomic enqueue_clip_generation tự chặn duplicate pending
 *        (partial unique index) + reuse guard.
 *      - Nếu đã có pending generation phù hợp → reuse (không tạo mới).
 *   3. Trả về ok — /watch tick tiếp sẽ hiện state kép "ready cũ + regenerating".
 *
 * Ca đặc biệt:
 *   - Failed row cuối: user retry → tạo pending mới, replacesClipId=null
 *     (không có ready cũ để bảo toàn). Failed row cũ vẫn ở đó, list
 *     lấy row mới nhất khi hiển thị.
 *   - Offline agent: KHÔNG enqueue (không có agent nhận), trả 409.
 *     Client hiện thông báo, retry sau khi agent lên.
 */
interface RouteContext {
  params: Promise<{ pe_id: string }>;
}

export async function POST(req: Request, ctx: RouteContext) {
  const { pe_id: packingEventId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(packingEventId)) {
    return NextResponse.json(
      { error: "packing_event_id_invalid" },
      { status: 400 },
    );
  }

  // Cắt theo yêu cầu / thử lại clip lỗi là một phần của "xem video" — mọi
  // vai trò xem được bằng chứng đều cần nó (clip chưa cắt hoặc đã hết hạn
  // trên cloud chỉ xem được sau khi cắt). Guard chuẩn còn lo luôn ngữ cảnh
  // tổ chức khi Platform đang xem hộ.
  const auth = await requirePermissionStrict("order_proof.view", req);
  if (isError(auth)) return auth;

  const admin = createAdminClient();

  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id, timing_status, status")
    .eq("id", packingEventId)
    .eq("organization_id", auth.organizationId)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json({ error: "packing_event_not_found" }, { status: 404 });
  }

  // 0) Proof integrity (2026-08-07): đơn chưa đóng thì KHÔNG cắt.
  // Cùng lý do với chốt chặn ở /watch — resolver thiếu work_ended_at sẽ
  // rơi nhánh default_post 60s và lưu clip cụt làm bằng chứng. Retry thủ
  // công là đường thứ hai vào enqueueCutClip nên phải chặn cả hai.
  const gate = evaluateProofClipGate(pe.timing_status, pe.status);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason, message: gate.message },
      { status: 409 },
    );
  }

  // 1) Tìm row ready hiện tại (nếu có) — làm replacesClipId cho generation mới.
  const { data: readyRow } = await admin
    .from("order_proof_clips")
    .select("id, status, bucket_path, bucket_uploaded_at")
    .eq("packing_event_id", packingEventId)
    .eq("organization_id", pe.organization_id)
    .eq("status", "ready")
    .maybeSingle();

  const replacesClipId = readyRow?.id ?? null;

  // Clip đang xem được trên cloud mà vẫn cắt lại = "Tạo lại" — thao tác ghi
  // (đổi bằng chứng đang có), không còn là "xem". Vai trò chỉ-xem bị chặn.
  if (
    readyRow &&
    clipBucketValid(readyRow as unknown as ScanClipSummary) &&
    !auth.isPlatform &&
    !(await roleHasPermission(auth.role, "order_proof.generate"))
  ) {
    return NextResponse.json(
      {
        error: "forbidden",
        permission: "order_proof.generate",
        message: "Bạn chỉ được xem video, không được tạo lại clip đang có.",
      },
      { status: 403 },
    );
  }

  // 2) Kiểm agent online. KHÔNG enqueue khi offline.
  const liveness = await readAgentLiveness(admin, pe.organization_id);
  if (!liveness.agent_id || liveness.is_offline) {
    return NextResponse.json(
      {
        error: "agent_offline",
        offline_duration_seconds: liveness.offline_duration_seconds,
      },
      { status: 409 },
    );
  }

  // 3) Enqueue safe cut_clip.
  try {
    const enqueueResult = await enqueueCutClip({
      organizationId: pe.organization_id,
      agentId: liveness.agent_id,
      packingEventId,
      replacesClipId,
    });
    if (!enqueueResult.ok) {
      return NextResponse.json(
        {
          error: enqueueResult.reason,
          message: enqueueResult.message,
        },
        { status: 200 },
      );
    }
    return NextResponse.json({
      ok: true,
      action: "regeneration_started",
      clip_id: enqueueResult.clip_id,
      command_id: enqueueResult.command_id,
      replaces_clip_id: replacesClipId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "enqueue_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
