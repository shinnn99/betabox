import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export interface RecordingSession {
  id: string;
  organization_id: string;
  camera_id: string;
  status: "recording" | "stopped" | "error" | "connection_lost";
  transport: "tcp" | "udp";
  segment_seconds: number;
  output_dir: string;
  started_at: string;
  stopped_at: string | null;
  last_heartbeat_at: string | null;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_COLUMNS =
  "id, organization_id, camera_id, status, transport, segment_seconds, output_dir, started_at, stopped_at, last_heartbeat_at, error_message, created_by, created_at, updated_at";

/**
 * Session đang recording thật (không phải 'stopped'/'error'/'connection_lost').
 * Dùng cho stop route để tìm session cần gửi command dừng.
 */
export async function getActiveSession(
  organizationId: string,
  cameraId: string,
): Promise<RecordingSession | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("camera_recording_sessions")
    .select(SESSION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("camera_id", cameraId)
    .eq("status", "recording")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RecordingSession | null) ?? null;
}

/**
 * Session gần nhất — bất kể status. Dùng cho status route để hiển thị
 * UI state (recording / stopped / error / connection_lost).
 */
export async function getLatestSession(
  organizationId: string,
  cameraId: string,
): Promise<RecordingSession | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("camera_recording_sessions")
    .select(SESSION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("camera_id", cameraId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RecordingSession | null) ?? null;
}

export async function markSessionStopped(
  sessionId: string,
  opts: { errorMessage?: string | null } = {},
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("camera_recording_sessions")
    .update({
      status: opts.errorMessage ? "error" : "stopped",
      stopped_at: new Date().toISOString(),
      error_message: opts.errorMessage ?? null,
    })
    .eq("id", sessionId);
  if (error) {
    // Session giữ status cũ (recording/error) — dashboard sẽ hiển thị sai.
    // Log để ops dọn tay. Không throw để caller (stop route) vẫn hoàn thành.
    console.error(
      `[markSessionStopped] update failed session=${sessionId} intended_status=${opts.errorMessage ? "error" : "stopped"} code=${error.code ?? "?"} message=${error.message}`,
    );
  }
}
