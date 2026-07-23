import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermissionStrict, isError } from "@/lib/supabase/guard";
import { enqueueCutClip } from "@/lib/agent-commands/enqueue";
import {
  ENQUEUE_CUT_COOLDOWN_SECONDS,
  OFFLINE_POLL_GIVEUP_MINUTES,
} from "@/lib/watch/config";
import {
  readAgentLiveness,
  type AgentLiveness,
} from "@/lib/watch/agent-liveness";
import { createProofClipSignedUrlByPackingEvent } from "@/lib/watch/proof-clip-signed-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe-retry S8 2026-07-06: reconcile endpoint với state kép.
 *
 * State kép:
 *   - `state='ready' + regenerating=false` — bình thường, chỉ 1 row ready.
 *   - `state='ready' + regenerating=true` — có ready cũ + pending mới
 *     song song. UI vẫn phát clip cũ, hiện badge "Đang tạo lại".
 *   - `state='preparing_cut'` — chưa có row ready nào, đang cắt lần đầu.
 *   - `state='failed'` — generation cuối cùng failed và KHÔNG có ready.
 *
 * Regenerating error: nếu row pending vừa chuyển 'failed' nhưng vẫn có
 * ready cũ, trả `state='ready' + regenerating=false + regeneration_error='...'`
 * — UI hiện cảnh báo, cho phép Retry lại.
 *
 * Ba trụ vẫn giữ:
 *   TRỤ 1 — bucket TRƯỚC agent.
 *   TRỤ 2 — re-check liveness mỗi tick.
 *   TRỤ 3 — giveup theo thời gian THẬT kho offline.
 */
interface RouteContext {
  params: Promise<{ pe_id: string }>;
}

type WatchState =
  | "preparing_cut"
  | "ready"
  | "failed"
  | "warehouse_offline"
  | "offline_giveup";

type RegenerationState = "encoding" | "uploading";

interface WatchResponse {
  state: WatchState;
  /** Có cấp URL của clip ready hiện tại (nếu có). */
  signed_url?: string;
  expires_at?: string;
  /** True khi có ready + pending song song (regeneration đang chạy). */
  regenerating?: boolean;
  regeneration_state?: RegenerationState;
  /** Set khi generation gần nhất failed nhưng vẫn có ready cũ. */
  regeneration_error?: string;
  /** Set khi state=failed. */
  error?: string;
  offline_duration_seconds?: number;
}

function offlineResponse(liveness: AgentLiveness): NextResponse<WatchResponse> {
  const giveupSeconds = OFFLINE_POLL_GIVEUP_MINUTES * 60;
  if (liveness.offline_duration_seconds >= giveupSeconds) {
    return NextResponse.json<WatchResponse>({
      state: "offline_giveup",
      offline_duration_seconds: liveness.offline_duration_seconds,
    });
  }
  return NextResponse.json<WatchResponse>({
    state: "warehouse_offline",
    offline_duration_seconds: liveness.offline_duration_seconds,
  });
}

async function hasRecentEnqueuedCut(
  admin: ReturnType<typeof createAdminClient>,
  packingEventId: string,
): Promise<boolean> {
  const sinceIso = new Date(
    Date.now() - ENQUEUE_CUT_COOLDOWN_SECONDS * 1000,
  ).toISOString();
  const { data } = await admin
    .from("agent_commands")
    .select("id")
    .eq("type", "cut_clip")
    .filter("payload->>packing_event_id", "eq", packingEventId)
    .gte("created_at", sinceIso)
    .limit(1);
  return (data ?? []).length > 0;
}

export async function POST(_req: Request, ctx: RouteContext) {
  const { pe_id: packingEventId } = await ctx.params;

  if (!/^[0-9a-f-]{36}$/i.test(packingEventId)) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "packing_event_id_invalid" },
      { status: 400 },
    );
  }

  const authCtx = await requirePermissionStrict("order_proof.view");
  if (isError(authCtx)) {
    // requirePermissionStrict trả NextResponse với status thật (401/403). Wrap
    // vào WatchResponse shape để client parse thống nhất — giữ status gốc.
    const status = authCtx.status;
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: status === 401 ? "unauthenticated" : "forbidden" },
      { status },
    );
  }

  const admin = createAdminClient();

  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id, proof_camera_id")
    .eq("id", packingEventId)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "packing_event_not_found" },
      { status: 404 },
    );
  }

  if (pe.organization_id !== authCtx.organizationId) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "cross_org_access_denied" },
      { status: 403 },
    );
  }

  // Load các row liên quan pe_id — có thể có ready + pending song song
  // (Safe Retry state kép) hoặc chỉ 1 trong 2. `superseded` bỏ qua.
  const { data: rows } = await admin
    .from("order_proof_clips")
    .select("id, status, progress_state, bucket_uploaded_at, error_message, created_at")
    .eq("packing_event_id", packingEventId)
    .eq("organization_id", pe.organization_id)
    .in("status", ["ready", "pending", "failed", "evicted"])
    .order("created_at", { ascending: false });

  const clips = rows ?? [];
  const readyRow = clips.find((c) => c.status === "ready") ?? null;
  const pendingRow = clips.find((c) => c.status === "pending") ?? null;
  const latestFailedRow = clips.find((c) => c.status === "failed") ?? null;
  // evicted = clip đã dọn khỏi cloud (72h TTL bucket) nhưng clip từng cắt
  // thành công. Xử lý ở nhánh 2 (không ready + không pending + không failed
  // sau ready) — tự enqueue cut lại từ video gốc, không bắt user bấm retry.
  const latestEvictedRow = clips.find((c) => c.status === "evicted") ?? null;

  // TRỤ 2: đọc liveness NGAY BÂY GIỜ.
  const liveness = await readAgentLiveness(admin, pe.organization_id);

  // ================ NHÁNH 1: có ready ================
  // Ưu tiên phát clip cũ. Nếu song song có pending → hiện regenerating.
  if (readyRow) {
    // TRỤ 1: cấp signed URL luôn.
    const signResult = await createProofClipSignedUrlByPackingEvent(
      { organizationId: pe.organization_id },
      packingEventId,
    );
    if (!signResult.ok) {
      // Ready row có nhưng signed URL fail — trả failed để user thấy lỗi.
      return NextResponse.json<WatchResponse>({
        state: "failed",
        error: `signed_url_failed: ${signResult.reason ?? "unknown"}`,
      });
    }

    const base: WatchResponse = {
      state: "ready",
      signed_url: signResult.signedUrl,
      expires_at: signResult.expiresAt,
    };

    if (pendingRow) {
      // Regeneration đang chạy song song. Derive regeneration_state
      // theo progress_state: 'encoding' → agent đang cắt; null →
      // hoặc mới queue hoặc vừa cắt xong đang upload. Không có state
      // riêng cho upload — dùng "uploading" như chỉ báo chung.
      const regState: RegenerationState =
        pendingRow.progress_state === "encoding" ? "encoding" : "uploading";
      return NextResponse.json<WatchResponse>({
        ...base,
        regenerating: true,
        regeneration_state: regState,
      });
    }

    // Không có pending song song. Nếu có failed vừa xảy ra sau ready
    // (created_at > ready.created_at), tức retry vừa fail → surface error.
    if (
      latestFailedRow &&
      new Date(latestFailedRow.created_at).getTime() >
        new Date(readyRow.created_at).getTime()
    ) {
      return NextResponse.json<WatchResponse>({
        ...base,
        regeneration_error:
          latestFailedRow.error_message ?? "regeneration_failed",
      });
    }

    return NextResponse.json<WatchResponse>(base);
  }

  // ================ NHÁNH 2: KHÔNG có ready ================
  // Có 4 nhánh con: pending / failed cuối / cooldown / enqueue mới.

  if (pendingRow) {
    // Đang cắt lần đầu (chưa có ready nào). Kiểm liveness.
    if (liveness.is_offline) return offlineResponse(liveness);
    return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
  }

  if (latestFailedRow) {
    // Không có ready, không có pending. Failed cuối = terminal state.
    return NextResponse.json<WatchResponse>({
      state: "failed",
      error: latestFailedRow.error_message ?? "cut_failed",
    });
  }

  // ================ NHÁNH 3: có evicted (2026-07-24) ================
  // Clip đã dọn khỏi cloud (72h TTL bucket) nhưng từng cắt thành công.
  // Auto enqueue cut lại từ video gốc (retention 35 ngày mặc định), không
  // bắt user bấm retry. Rớt xuống nhánh cooldown/enqueue phía dưới với
  // message rõ khi trả preparing_cut ở nhánh cooldown, hoặc mapping message
  // của enqueueCutClip khi fail (VD segment gốc cũng quá hạn retention).
  //
  // Không set flag đặc biệt — cooldown 60s + logic enqueue phía dưới xử lý
  // đầy đủ (kể cả ca no_segments = segment gốc đã dọn theo retention).
  // Nhánh này chỉ thay đổi nhãn state cho user hiểu đúng.
  const isEvictedRegen = !!latestEvictedRow;

  // Chưa có row nào — kiểm cooldown + enqueue lần cắt đầu.
  const cutRecent = await hasRecentEnqueuedCut(admin, packingEventId);
  if (cutRecent) {
    if (liveness.is_offline) return offlineResponse(liveness);
    return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
  }

  if (liveness.is_offline) return offlineResponse(liveness);

  if (!pe.proof_camera_id) {
    return NextResponse.json<WatchResponse>({
      state: "failed",
      error: "no_camera_for_event",
    });
  }
  if (!liveness.agent_id) return offlineResponse(liveness);

  let cutResult;
  try {
    cutResult = await enqueueCutClip({
      organizationId: pe.organization_id,
      agentId: liveness.agent_id,
      packingEventId,
      replacesClipId: null,
    });
  } catch (err) {
    return NextResponse.json<WatchResponse>({
      state: "failed",
      error: `enqueue_cut_failed: ${(err as Error).message}`,
    });
  }

  if (!cutResult.ok) {
    // Enqueue fail với reason có ý nghĩa nghiệp vụ. Map ra user-facing
    // message. expired_retention = nghiệp vụ (quá hạn lưu trữ theo cấu
    // hình org), phân biệt với no_segments (chưa cấu hình retention
    // hoặc file mất trong hạn = bug).
    //
    // Ca đặc biệt (2026-07-24): evicted regen + segment gốc cũng quá
    // hạn retention → không cứu được. Message phải nói rõ "video gốc
    // quá hạn", không mô tả nhầm là "cắt clip thất bại".
    const isEvictedNoSource =
      isEvictedRegen &&
      (cutResult.reason === "expired_retention" || cutResult.reason === "no_segments");
    const userMessage = isEvictedNoSource
      ? "Clip cũ đã dọn khỏi cloud (giữ 72 giờ) và video gốc trên máy kho cũng đã hết hạn lưu trữ. Không tạo lại được clip cho đơn này."
      : cutResult.reason === "expired_retention"
        ? cutResult.message ?? "Video đã quá hạn lưu trữ."
        : cutResult.reason === "no_segments"
          ? "Không có video trong khoảng thời gian đơn hàng (segment ổ đã dọn hoặc chưa có ghi hình)."
          : cutResult.reason === "no_camera"
            ? "Đơn không gán camera bằng chứng."
            : cutResult.reason === "segment_still_open"
              ? "Segment cuối chưa đóng, thử lại sau vài giây."
              : cutResult.reason === "not_found"
                ? "Không tìm thấy đơn."
                : `enqueue_cut_failed: ${cutResult.message ?? "unknown"}`;

    // Insert row failed để reconcile tick sau thấy status=failed thay
    // vì "chưa có row" (loop). Camera_id null nếu no_camera.
    // Chỉ insert khi CHƯA có row nào (đã kiểm ở đầu — không có ready
    // /pending/failed).
    //
    // HIGH-15: destruct .error. Nếu insert failed clip BỊ REJECT (RLS,
    // unique constraint race) → KHÔNG trả preparing_cut giả — tick sau
    // sẽ lại thấy "chưa có row" → enqueue cut lại → loop hoại. Trả
    // failed rõ ràng để UI dừng poll và ops kiểm log.
    const { error: insErr } = await admin
      .from("order_proof_clips")
      .insert({
        organization_id: pe.organization_id,
        packing_event_id: packingEventId,
        waybill_code: "",
        camera_id: pe.proof_camera_id,
        status: "failed",
        error_message: userMessage,
      });
    if (insErr) {
      console.error(
        `[watch] insert failed clip row failed pe=${packingEventId} org=${pe.organization_id} code=${insErr.code ?? "?"} message=${insErr.message}`,
      );
      // Vẫn trả failed cho client thay vì preparing_cut để BLOCK loop.
      // Client dừng poll ở state=failed; user cần refresh sau khi ops fix.
      return NextResponse.json<WatchResponse>({
        state: "failed",
        error: `${userMessage} [reconcile-write-failed]`,
      });
    }

    return NextResponse.json<WatchResponse>({
      state: "failed",
      error: userMessage,
    });
  }

  return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
}
