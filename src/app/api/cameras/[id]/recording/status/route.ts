import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isError,
  requirePermission,
} from "@/lib/supabase/guard";
import {
  getLatestSession,
} from "@/lib/camera/recording-service";
import { getCameraRow } from "@/lib/camera/service";
import { deriveUiState as deriveUiStateCore, type RecordingUiState } from "@/lib/recording/ui-state";

export type { RecordingUiState };

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

/**
 * Lát 2 SaaS refactor: /recording/status chuyển từ kiểu web-kiểm-process
 * (isAlive + newestFileMtime đọc fs local) → đọc DB thuần theo agent-pattern.
 *
 * Kiến trúc cũ giả định ffmpeg chạy TRONG process Vercel: status route
 * kiểm getRecording(cameraId) trong in-memory map, KHÔNG thấy → flip
 * session sang 'error' với message "Recording process not found". Trên
 * Vercel serverless, ffmpeg KHÔNG BAO GIỜ chạy trong process của route →
 * flip nhầm mọi session recording sang error mỗi lần UI poll → "Lỗi ghi"
 * giả trong khi agent kho vẫn ghi thật.
 *
 * Nguồn chân lý mới:
 *   - `camera_recording_sessions.status` — agent tự cập nhật qua poll.
 *   - `camera_recording_sessions.last_heartbeat_at` — agent piggyback
 *     mỗi 3s qua /api/agent/poll-commands (agent_state.active_recordings).
 *   - `warehouse_agents.last_seen_at` — agent còn sống nói chung.
 *
 * Ba nhánh trạng thái:
 *   1. status='recording' + session heartbeat tươi (< 90s) → recording.
 *   2. status='recording' + heartbeat stale hoặc agent offline
 *      → agent_disconnected (KHÔNG error — agent hiccup mạng vẫn ghi
 *      local; báo lỗi = nói dối).
 *   3. status='stopped' → stopped.
 *   4. status='error' → error (chỉ khi agent xác nhận qua báo error thật,
 *      không phải do web đoán).
 *
 * Chú ý phân biệt hai cột heartbeat:
 *   - session.last_heartbeat_at (90s stale): "session này đang ghi".
 *   - agent.last_seen_at (60s stale): "agent còn sống".
 * Không dùng lẫn.
 */
const SESSION_HEARTBEAT_STALE_MS = Number(
  process.env.RECORDING_SESSION_STALE_MS ?? 90_000,
);
const AGENT_ONLINE_STALE_MS = Number(
  process.env.AGENT_ONLINE_STALE_MS ?? 60_000,
);

function deriveUiState(input: {
  sessionStatus: string | null;
  sessionHeartbeatAt: string | null;
  agentLastSeenAt: string | null;
  now: number;
}): RecordingUiState {
  return deriveUiStateCore({
    sessionStatus: input.sessionStatus,
    sessionHeartbeatAt: input.sessionHeartbeatAt,
    agentLastSeenAt: input.agentLastSeenAt,
    now: input.now,
    sessionHeartbeatStaleMs: SESSION_HEARTBEAT_STALE_MS,
    agentOnlineStaleMs: AGENT_ONLINE_STALE_MS,
  });
}

export async function GET(_req: Request, { params }: RouteContext) {
  const ctx = await requirePermission("camera.recording.view");
  if (isError(ctx)) return ctx;
  const { id } = await params;

  const camera = await getCameraRow(ctx.organizationId, id);
  if (!camera) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const session = await getLatestSession(ctx.organizationId, id);

  // Agent gần nhất còn sống của org — dùng để phân biệt "agent mất kết
  // nối" với "recording error". Không gắn cứng agent-camera 1-1 vì cùng
  // org có thể có nhiều agent (multi-kho tương lai) — session vẫn thuộc
  // đúng org.
  const admin = createAdminClient();
  const { data: agent } = await admin
    .from("warehouse_agents")
    .select("last_seen_at")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const uiState = deriveUiState({
    sessionStatus: session?.status ?? null,
    sessionHeartbeatAt: session?.last_heartbeat_at ?? null,
    agentLastSeenAt: agent?.last_seen_at ?? null,
    now: Date.now(),
  });

  return NextResponse.json({
    ui_state: uiState,
    is_recording: uiState === "recording",
    session,
    agent_last_seen_at: agent?.last_seen_at ?? null,
  });
}
