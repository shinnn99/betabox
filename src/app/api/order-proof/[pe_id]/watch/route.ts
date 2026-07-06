import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  enqueueCutClip,
  enqueueUploadClip,
} from "@/lib/agent-commands/enqueue";
import {
  ENQUEUE_CUT_COOLDOWN_SECONDS,
  OFFLINE_POLL_GIVEUP_MINUTES,
  UPLOAD_FAILED_COOLDOWN_MINUTES,
  bucketPathFor,
} from "@/lib/watch/config";
import {
  readAgentLiveness,
  type AgentLiveness,
} from "@/lib/watch/agent-liveness";
import { createProofClipSignedUrlByPackingEvent } from "@/lib/watch/proof-clip-signed-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 3c + 3d: reconcile endpoint (server-driven state machine).
 *
 * POST vì có thể enqueue job (side-effect). Web poll mỗi 2s (active)
 * hoặc mỗi 20s (offline) cho tới ready/failed/upload_failed/offline_giveup.
 *
 * Ba trụ 3d:
 *
 * TRỤ 1 — Bucket TRƯỚC agent:
 *   Nếu clip đã ở cloud (bucket_uploaded_at còn trong TTL 72h),
 *   cấp signed URL luôn, KỆ agent offline. Agent không liên quan
 *   khi clip đã lên cloud rồi.
 *
 * TRỤ 2 — Re-check agent liveness MỖI TICK:
 *   State derived from NOW, not memory. Query đọc last_seen_at
 *   trong tick này, tính offline theo now(). Nếu job enqueue lúc
 *   agent còn online rồi agent chết, tick sau thấy last_seen_at
 *   quá 30s → warehouse_offline, không tin quyết định enqueue cũ.
 *
 * TRỤ 3 — Giveup theo THỜI GIAN THẬT của kho:
 *   offline_duration_seconds = now() - last_seen_at (server tính).
 *   Client CHỈ nhận + hiển thị + dừng khi server trả offline_giveup.
 *   Không tính client-side (bug: reload trốn giveup, mở tab muộn chờ oan).
 */
interface RouteContext {
  params: Promise<{ pe_id: string }>;
}

type WatchState =
  | "preparing_cut"
  | "preparing_upload"
  | "ready"
  | "failed"
  | "upload_failed"
  | "warehouse_offline"
  | "offline_giveup"
  | "unknown";

interface WatchResponse {
  state: WatchState;
  signed_url?: string;
  expires_at?: string;
  error?: string;
  offline_duration_seconds?: number;
}

/**
 * TRỤ 2 — đọc last_seen_at MỖI TICK, derive is_offline TẠI THỜI ĐIỂM
 * NÀY. Không cache, không snapshot, không lưu lúc enqueue.
 *
 * Logic tách sang @/lib/watch/agent-liveness để dùng chung với list
 * (/api/order-proof/scans). Cùng HÀM, không chỉ cùng cột — chép logic
 * là mầm lệch badge giữa list và detail.
 */

async function hasActiveJob(
  admin: ReturnType<typeof createAdminClient>,
  type: "cut_clip" | "upload_clip",
  packingEventId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("agent_commands")
    .select("id")
    .eq("type", type)
    .filter("payload->>packing_event_id", "eq", packingEventId)
    .in("status", ["pending", "taken"])
    .limit(1);
  return (data ?? []).length > 0;
}

async function hasRecentFailedUpload(
  admin: ReturnType<typeof createAdminClient>,
  packingEventId: string,
): Promise<boolean> {
  const sinceIso = new Date(
    Date.now() - UPLOAD_FAILED_COOLDOWN_MINUTES * 60 * 1000,
  ).toISOString();
  const { data } = await admin
    .from("agent_commands")
    .select("id")
    .eq("type", "upload_clip")
    .eq("status", "failed")
    .filter("payload->>packing_event_id", "eq", packingEventId)
    .gte("completed_at", sinceIso)
    .limit(1);
  return (data ?? []).length > 0;
}

/**
 * Cooldown chặn dội enqueue cut_clip.
 *
 * Vấn đề (2026-07-03): rà DB cho pe_id = 32 command done + 0 row
 * ready trong 10 phút. Nguyên nhân: `hasActiveJob` chỉ check pending/
 * taken; command đã `done` không tính. Agent skip idempotent + không
 * insert row → tick sau thấy "không job + không row ready" → enqueue.
 * Loop.
 *
 * Cooldown chặn ĐỘI ở mọi đường (kể cả sau khi agent-side (C) fix):
 * check command `cut_clip` gần nhất theo `created_at` (BẤT KỂ status —
 * pending/taken/done/failed đều tính). Trong 60s qua có bất kỳ command
 * nào cho pe_id này → không enqueue nữa, chờ.
 *
 * Đo theo `created_at` (không `completed_at`) để command đang taken
 * cũng nằm trong cửa sổ → không enqueue chồng khi agent đang chạy.
 *
 * User bấm [Thử lại] bypass cooldown bằng cách WIPE SLATE (xóa
 * `agent_commands` cho pe_id) — không phải bypass ngoại lệ. Xem
 * /watch/retry route.
 */
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

/**
 * Precheck (A): "không có segment" đã được xử ở tầng `enqueueCutClip`
 * (src/lib/agent-commands/enqueue.ts dòng 351-358, `resolved.files
 * === 0` → return { ok: false, reason: "no_segments" }`). Vấn đề trước
 * là /watch KHÔNG bắt return value của enqueueCutClip — chỉ `await`
 * không kiểm — nên `no_segments` bị nuốt sạch, /watch vẫn trả
 * preparing_cut, modal poll mãi.
 *
 * Fix: dưới đây bắt return value, nếu reason=`no_segments` → set
 * order_proof_clips.status='failed' với message người đọc.
 *
 * Cọc #7: khi Lát 5 cleanup ổ, phải xóa row `camera_recording_files`
 * tương ứng, không thì `resolved.files > 0` nhưng ổ không có file →
 * agent cắt fail. Hiện tại (2026-07-03) DB-ổ đồng bộ vì chưa cleanup.
 */

/**
 * TRỤ 3 — offline_duration đo THỜI GIAN THẬT KHO OFFLINE (từ
 * last_seen_at), so ngưỡng giveup. Server quyết offline_giveup, KHÔNG
 * client tự tính.
 *
 * Trả về response tương ứng cho state offline. Không enqueue mới khi
 * offline — tránh chồng job pending vô ích. Job cũ (nếu có) nằm
 * pending, khi agent về sẽ tự claim.
 */
function offlineResponse(
  liveness: AgentLiveness,
): NextResponse<WatchResponse> {
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

export async function POST(_req: Request, ctx: RouteContext) {
  const { pe_id: packingEventId } = await ctx.params;

  if (!/^[0-9a-f-]{36}$/i.test(packingEventId)) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "packing_event_id_invalid" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "unauthenticated" },
      { status: 401 },
    );
  }

  const admin = createAdminClient();

  const { data: pe } = await admin
    .from("packing_events")
    .select("id, organization_id, proof_camera_id, waybill_code")
    .eq("id", packingEventId)
    .maybeSingle();
  if (!pe) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "packing_event_not_found" },
      { status: 404 },
    );
  }

  const { data: profile } = await admin
    .from("user_profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.organization_id !== pe.organization_id) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "cross_org_access_denied" },
      { status: 403 },
    );
  }

  // Load current clip row
  const { data: clip } = await admin
    .from("order_proof_clips")
    .select(
      "id, status, progress_state, bucket_path, bucket_uploaded_at, error_message",
    )
    .eq("packing_event_id", packingEventId)
    .maybeSingle();

  // Terminal: failed
  if (clip?.status === "failed") {
    return NextResponse.json<WatchResponse>({
      state: "failed",
      error: clip.error_message ?? "cut_failed",
    });
  }

  // TRỤ 1 — check bucket TRƯỚC agent. Clip đã cloud → cấp URL, KỆ agent.
  // N2 DiD-A: KHÔNG gọi createSignedUrl trực tiếp. Helper verify org
  // trong nó (tầng thứ hai sau verify ở dòng ~232) — cross-tenant lộ
  // chéo phải qua CẢ HAI tầng thì mới lọt. Grep-CI cấm createSignedUrl
  // ngoài src/lib/watch/proof-clip-signed-url.ts.
  if (clip?.status === "ready") {
    const signResult = await createProofClipSignedUrlByPackingEvent(
      { organizationId: pe.organization_id },
      packingEventId,
    );
    if (signResult.ok) {
      return NextResponse.json<WatchResponse>({
        state: "ready",
        signed_url: signResult.signedUrl,
        expires_at: signResult.expiresAt,
      });
    }
    if (signResult.reason === "signed_url_failed") {
      return NextResponse.json<WatchResponse>(
        {
          state: "failed",
          error: `signed_url_failed: ${signResult.message ?? "unknown"}`,
        },
        { status: 200 },
      );
    }
    // bucket_missing / bucket_expired → rơi xuống nhánh upload_failed /
    // enqueue upload bên dưới. not_found/cross_org không đạt vì đã verify
    // ở tầng trên; nếu lọt (race), rơi xuống nhánh dưới xử tiếp cũng an
    // toàn (helper đã chặn cấp URL).
  }

  // Từ đây, mọi nhánh CẦN agent. Đọc liveness NGAY BÂY GIỜ (TRỤ 2).
  const liveness = await readAgentLiveness(admin, pe.organization_id);

  // Terminal: upload_failed (trước cả check offline — user thấy lỗi cụ thể)
  if (clip?.status === "ready") {
    // clip ready + bucket null/expired
    const uploadPending = await hasActiveJob(admin, "upload_clip", packingEventId);
    const recentFailed = await hasRecentFailedUpload(admin, packingEventId);

    if (recentFailed && !uploadPending) {
      return NextResponse.json<WatchResponse>({
        state: "upload_failed",
        error: "upload_recently_failed_wait_cooldown_or_retry",
      });
    }

    if (uploadPending) {
      // Có job upload pending/taken — check agent liveness.
      // TRỤ 2: agent có thể ĐÃ chết sau khi enqueue.
      if (liveness.is_offline) {
        return offlineResponse(liveness);
      }
      return NextResponse.json<WatchResponse>({ state: "preparing_upload" });
    }

    // Không có upload pending → cần enqueue upload.
    // TRỤ 2: nếu agent offline BÂY GIỜ, KHÔNG enqueue (tránh job pending
    // vô ích). Trả offline luôn.
    if (liveness.is_offline) {
      return offlineResponse(liveness);
    }

    if (!pe.proof_camera_id) {
      return NextResponse.json<WatchResponse>(
        { state: "failed", error: "no_camera_for_event" },
        { status: 200 },
      );
    }
    if (!liveness.agent_id) {
      // Không có agent → offline
      return offlineResponse(liveness);
    }
    const bucketPath = bucketPathFor(pe.organization_id, packingEventId);
    try {
      await enqueueUploadClip({
        organizationId: pe.organization_id,
        agentId: liveness.agent_id,
        packingEventId,
        bucketPath,
      });
    } catch (err) {
      return NextResponse.json<WatchResponse>(
        { state: "failed", error: `enqueue_upload_failed: ${(err as Error).message}` },
        { status: 200 },
      );
    }
    return NextResponse.json<WatchResponse>({ state: "preparing_upload" });
  }

  // clip đang encoding (status=pending + progress_state='encoding')
  if (clip?.status === "pending") {
    // Có agent làm việc — kiểm liveness. TRỤ 2 áp cho cả cut.
    if (liveness.is_offline) {
      return offlineResponse(liveness);
    }
    return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
  }

  // Chưa có clip row
  const cutPending = await hasActiveJob(admin, "cut_clip", packingEventId);
  if (cutPending) {
    // Có job cut pending — kiểm agent (TRỤ 2, ca cửa sổ 30s cho cut).
    if (liveness.is_offline) {
      return offlineResponse(liveness);
    }
    return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
  }

  // Cooldown: chặn dội enqueue cho pe_id đã có command cut_clip trong
  // 60s qua (BẤT KỂ status: pending/taken/done/failed). Chống loop
  // done→không-row-ready→enqueue-lại đã quan sát 2026-07-03 (32 command
  // done trong 10 phút cho 1 pe_id).
  //
  // Ca đang taken (chưa hết cooldown): trả preparing_cut, modal hiển
  // thị "đang tải clip" — vì agent thật sự đang chạy.
  const cutRecent = await hasRecentEnqueuedCut(admin, packingEventId);
  if (cutRecent) {
    if (liveness.is_offline) {
      return offlineResponse(liveness);
    }
    return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
  }

  // Không có clip + không có job đang chạy + không cooldown → enqueue.
  if (liveness.is_offline) {
    return offlineResponse(liveness);
  }

  if (!pe.proof_camera_id) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: "no_camera_for_event" },
      { status: 200 },
    );
  }
  if (!liveness.agent_id) {
    return offlineResponse(liveness);
  }

  // (A) precheck qua return value enqueueCutClip. `enqueueCutClip`
  // gọi resolveClipBounds → nếu 0 segment cho window → trả
  // { ok:false, reason:"no_segments" } (KHÔNG throw). Trước đây /watch
  // await mà không bắt return → nuốt sạch → modal poll mãi.
  let cutResult;
  try {
    cutResult = await enqueueCutClip({
      organizationId: pe.organization_id,
      agentId: liveness.agent_id,
      packingEventId,
    });
  } catch (err) {
    return NextResponse.json<WatchResponse>(
      { state: "failed", error: `enqueue_cut_failed: ${(err as Error).message}` },
      { status: 200 },
    );
  }

  if (!cutResult.ok) {
    // Map reason enqueueCutClip → message người đọc + insert row failed
    // để tick sau /watch thấy status=failed (không phải "chưa có row").
    // Modal hiện "Không có video trong khoảng đơn hàng" NGAY, không
    // poll vô hạn.
    const userMessage =
      cutResult.reason === "no_segments"
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
    await admin.from("order_proof_clips").insert({
      organization_id: pe.organization_id,
      packing_event_id: packingEventId,
      waybill_code: pe.waybill_code ?? "",
      camera_id: pe.proof_camera_id,
      status: "failed",
      error_message: userMessage,
    });

    return NextResponse.json<WatchResponse>(
      { state: "failed", error: userMessage },
      { status: 200 },
    );
  }

  return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
}
