import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  enqueueCutClip,
  enqueueUploadClip,
} from "@/lib/agent-commands/enqueue";
import {
  AGENT_OFFLINE_THRESHOLD_SECONDS,
  BUCKET_NAME,
  BUCKET_TTL_HOURS,
  OFFLINE_POLL_GIVEUP_MINUTES,
  SIGNED_URL_TTL_SECONDS,
  UPLOAD_FAILED_COOLDOWN_MINUTES,
  bucketPathFor,
} from "@/lib/watch/config";

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

interface AgentLiveness {
  agent_id: string | null;
  last_seen_at: string | null;
  is_offline: boolean;
  offline_duration_seconds: number;
}

/**
 * TRỤ 2 — đọc last_seen_at MỖI TICK, derive is_offline TẠI THỜI ĐIỂM
 * NÀY. Không cache, không snapshot, không lưu lúc enqueue.
 *
 * Nếu không có agent nào active cho org → is_offline=true, duration=∞
 * (đại diện bằng số lớn — không thể phục hồi).
 */
async function readAgentLiveness(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<AgentLiveness> {
  const { data: agent } = await admin
    .from("warehouse_agents")
    .select("id, last_seen_at")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!agent) {
    return {
      agent_id: null,
      last_seen_at: null,
      is_offline: true,
      // Số lớn — nếu vượt giveup threshold sẽ trigger giveup luôn.
      offline_duration_seconds: 999_999_999,
    };
  }
  if (!agent.last_seen_at) {
    // Agent chưa từng poll (mới tạo, chưa chạy) — coi như offline.
    return {
      agent_id: agent.id,
      last_seen_at: null,
      is_offline: true,
      offline_duration_seconds: 999_999_999,
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
  if (clip?.status === "ready") {
    const ttlMs = BUCKET_TTL_HOURS * 3600 * 1000;
    const uploadedAt = clip.bucket_uploaded_at
      ? new Date(clip.bucket_uploaded_at).getTime()
      : 0;
    const ageMs = Date.now() - uploadedAt;
    const bucketValid =
      clip.bucket_path !== null &&
      clip.bucket_uploaded_at !== null &&
      ageMs < ttlMs;

    if (bucketValid && clip.bucket_path) {
      // Cấp signed URL mới mỗi call — không cache
      const { data: signed, error: signedErr } = await admin.storage
        .from(BUCKET_NAME)
        .createSignedUrl(clip.bucket_path, SIGNED_URL_TTL_SECONDS);
      if (signedErr || !signed) {
        return NextResponse.json<WatchResponse>(
          {
            state: "failed",
            error: `signed_url_failed: ${signedErr?.message ?? "unknown"}`,
          },
          { status: 200 },
        );
      }
      const expiresAt = new Date(
        Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
      ).toISOString();
      return NextResponse.json<WatchResponse>({
        state: "ready",
        signed_url: signed.signedUrl,
        expires_at: expiresAt,
      });
    }
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

  // Không có clip + không có job → cần enqueue cut. Kiểm agent BÂY GIỜ.
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
  try {
    await enqueueCutClip({
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
  return NextResponse.json<WatchResponse>({ state: "preparing_cut" });
}
