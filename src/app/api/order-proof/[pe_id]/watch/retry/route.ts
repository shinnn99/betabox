import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { readAgentLiveness } from "@/lib/watch/agent-liveness";
import { enqueueCutClip } from "@/lib/agent-commands/enqueue";

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

export async function POST(_req: Request, ctx: RouteContext) {
  const { pe_id: packingEventId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(packingEventId)) {
    return NextResponse.json(
      { error: "packing_event_id_invalid" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id")
    .eq("id", packingEventId)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json({ error: "packing_event_not_found" }, { status: 404 });
  }
  const { data: profile } = await admin
    .from("user_profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.organization_id !== pe.organization_id) {
    return NextResponse.json(
      { error: "cross_org_access_denied" },
      { status: 403 },
    );
  }

  // 1) Tìm row ready hiện tại (nếu có) — làm replacesClipId cho generation mới.
  const { data: readyRow } = await admin
    .from("order_proof_clips")
    .select("id")
    .eq("packing_event_id", packingEventId)
    .eq("organization_id", pe.organization_id)
    .eq("status", "ready")
    .maybeSingle();

  const replacesClipId = readyRow?.id ?? null;

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
