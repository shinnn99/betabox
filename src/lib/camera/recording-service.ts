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
 * Session CHƯA ĐÓNG — mọi trạng thái trừ đã có `stopped_at`.
 *
 * Dùng riêng cho thao tác dừng. `getActiveSession` lọc cứng
 * status='recording', nghĩa là session rơi vào 'error' hay
 * 'connection_lost' thì không còn đường dừng qua sản phẩm: UI ẩn nút
 * (vì cloud tin là không ghi) và API trả 409 — trong khi agent ở kho
 * vẫn giữ desired và spawn ffmpeg mỗi 5 phút. Đó là deadlock hik_01
 * kho Đại Kim 24/07→05/08, phải sửa DB tay mới thoát được.
 *
 * `stopped_at IS NULL` mới là định nghĩa đúng của "còn mở": nó là thứ
 * agent và cloud cùng đồng ý, không phụ thuộc lần báo trạng thái cuối
 * rơi vào nhánh nào.
 */
export async function getOpenSessionForStop(
  organizationId: string,
  cameraId: string,
): Promise<RecordingSession | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("camera_recording_sessions")
    .select(SESSION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("camera_id", cameraId)
    .is("stopped_at", null)
    .in("status", ["recording", "error", "connection_lost"])
    // Ưu tiên session đang recording; giữa các session cùng loại lấy mới
    // nhất. Kho có session mồ côi cũ (hik_01 có 2) thì phải nhắm đúng cái
    // agent đang bám, không phải cái già nhất.
    .order("status", { ascending: true }) // 'connection_lost' < 'error' < 'recording'
    .order("started_at", { ascending: false })
    .limit(10);
  const rows = (data as RecordingSession[] | null) ?? [];
  if (rows.length === 0) return null;
  return rows.find((r) => r.status === "recording") ?? rows[0];
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
